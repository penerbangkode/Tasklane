import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Atk from 'gi://Atk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

function secondsToText(value) {
    const s = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function normalizeTask(task) {
    if (!task || typeof task.id !== 'string' || typeof task.title !== 'string') return null;
    return {
        id: task.id, title: task.title,
        elapsed: Number.isFinite(Number(task.elapsed)) ? Math.max(0, Number(task.elapsed)) : 0, done: !!task.done,
        ...(typeof task.finishedAt === 'string' ? {finishedAt: task.finishedAt} : {}),
    };
}

export default class TasklaneExtension extends Extension {
    enable() {
        if (this._indicator) return;
        this._path = GLib.build_filenamev([GLib.get_user_data_dir(), 'tasklane', 'state.json']);
        this._state = this._load();
        this._selectedTab = 'todo';
        this._settingsOpen = false;
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._a11ySettings = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
        this._appearanceSignal = this._interfaceSettings.connect('changed::color-scheme', () => {
            if (this._state.theme === 'system') this._applyTheme();
        });
        this._contrastSignal = this._a11ySettings.connect('changed::high-contrast', () => this._applyTheme());
        this._indicator = new PanelMenu.Button(0.0, 'Tasklane', false);
        const layout = new St.BoxLayout({style_class: 'tasklane-panel'});
        this._panelIcon = new St.Icon({icon_name: 'view-list-symbolic', style_class: 'system-status-icon tasklane-panel-icon'});
        layout.add_child(this._panelIcon);
        this._panelLabel = new St.Label({text: 'Tasklane', y_align: Clutter.ActorAlign.CENTER});
        layout.add_child(this._panelLabel);
        this._indicator.add_child(layout);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.menu.actor.connect('captured-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS) return Clutter.EVENT_PROPAGATE;
            return this._handleMenuKeyPress(event);
        });
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (!open) {
                this._resetTaskReveals();
                this._stopSwitchAnimations();
                this._closeTaskOptions();
                this._setSettingsOpen(false, false);
            } else {
                // The pointer may have moved while the popup was unmapped.
                for (const {row} of this._taskReveals?.values() ?? []) row.sync_hover();
                this._syncTaskReveals(false);
            }
        });
        this._rowFocusSignal = global.stage.connect('notify::key-focus', () => this._syncTaskReveals());
        this._renderMenu();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._refreshLabels();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._rowFocusSignal) global.stage.disconnect(this._rowFocusSignal);
        this._rowFocusSignal = null;
        this._resetTaskReveals();
        this._taskReveals = null;
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
        if (this._appearanceSignal) this._interfaceSettings.disconnect(this._appearanceSignal);
        if (this._contrastSignal) this._a11ySettings.disconnect(this._contrastSignal);
        this._appearanceSignal = this._contrastSignal = null;
        this._interfaceSettings = this._a11ySettings = null;
        // Pause on disable so a disabled extension never bills phantom time.
        if (this._state) this._pause();
        this._stopSwitchAnimations();
        this._indicator?.destroy();
        this._indicator = null;
        this._panelLabel = null;
        this._panelIcon = null;
        this._durationLabel = null;
        this._taskOptions = null;
        this._todoList = null;
        this._completedList = null;
        this._tabButtons = null;
        this._listScroll = null;
        this._entry = null;
        this._settingsView = null;
        this._taskView = null;
        this._settingsButton = null;
        this._settingsBack = null;
        this._statusLabel = null;
        this._timerControl = null;
        this._themeChoices = null;
        this._focusTargets = null;
        this._state = null;
    }

    _load() {
        const empty = {tasks: [], activeId: null, since: null, theme: 'system', lastDeleted: null};
        try {
            let file = Gio.File.new_for_path(this._path);
            const migrating = !file.query_exists(null);
            if (migrating) {
                const legacyPath = GLib.build_filenamev([GLib.get_user_data_dir(), 'ticket-sprint', 'state.json']);
                file = Gio.File.new_for_path(legacyPath);
                if (!file.query_exists(null)) return empty;
            }
            const [ok, bytes] = file.load_contents(null);
            if (!ok) return empty;
            const parsed = JSON.parse(new TextDecoder().decode(bytes));
            if (!Array.isArray(parsed.tasks)) return empty;
            const ids = new Set();
            const tasks = parsed.tasks.map(normalizeTask).filter(task => {
                if (!task || ids.has(task.id)) return false;
                ids.add(task.id);
                return true;
            });
            const active = tasks.find(task => task.id === parsed.activeId && !task.done);
            const state = {
                tasks,
                activeId: active?.id ?? null,
                since: active && Number.isFinite(parsed.since) ? parsed.since : null,
                theme: ['system', 'light', 'dark'].includes(parsed.theme) ? parsed.theme : 'system',
                lastDeleted: normalizeTask(parsed.lastDeleted?.task)
                    ? {task: normalizeTask(parsed.lastDeleted.task), index: Math.max(0, Math.floor(Number(parsed.lastDeleted.index) || 0))} : null,
            };
            // Copy valid legacy data once; retain the original as a backup.
            if (migrating) this._save(state);
            return state;
        } catch (e) {
            console.warn(`[Tasklane] Could not load state: ${e}`);
            return empty;
        }
    }

    _save(state = this._state) {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._path), 0o700);
            const file = Gio.File.new_for_path(this._path);
            const content = new TextEncoder().encode(JSON.stringify(state, null, 2));
            file.replace_contents(content, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error(`[Tasklane] Could not save state: ${e}`);
        }
    }

    _active() {
        return this._state.tasks.find(t => t.id === this._state.activeId && !t.done) ?? null;
    }

    _elapsed(task) {
        // Wall-clock timestamps intentionally include suspend while enabled.
        // The timeout only refreshes labels; it never increments task time.
        const live = task.id === this._state.activeId && this._state.since !== null
            ? Math.max(0, (Date.now() - this._state.since) / 1000) : 0;
        return task.elapsed + live;
    }

    _pause() {
        const current = this._active();
        if (current && this._state.since !== null) {
            current.elapsed = this._elapsed(current);
        }
        this._state.since = null;
        this._save();
        this._refreshLabels();
    }

    _start(id, focusKey = `play:${id}`) {
        const task = this._state.tasks.find(t => t.id === id && !t.done);
        if (!task) return;
        if (this._state.activeId === id && this._state.since !== null) return;
        this._pause();
        this._state.activeId = id;
        this._state.since = Date.now();
        this._save();
        this._renderMenu(focusKey);
    }

    _activateTask(id, focusKey = null) {
        const task = this._state.tasks.find(t => t.id === id && !t.done);
        if (!task) return;
        if (this._state.activeId === id && this._state.since !== null) {
            this._pause();
            this._renderMenu(focusKey);
        } else {
            this._start(id, focusKey);
        }
    }

    _toggle(focusKey = null) {
        const task = this._active() ?? this._state.tasks.find(t => !t.done);
        if (task) this._activateTask(task.id, focusKey);
    }

    _playbackLabel(task) {
        if (task?.id === this._state.activeId && this._state.since !== null) return 'Pause';
        return task && (task.elapsed > 0 || task.id === this._state.activeId) ? 'Resume' : 'Start';
    }

    _complete(id) {
        const task = this._state.tasks.find(t => t.id === id);
        if (!task || task.done) return;
        const wasActive = id === this._state.activeId;
        if (wasActive) this._pause();
        task.done = true;
        task.finishedAt = new Date().toISOString();
        if (wasActive) {
            this._state.activeId = null;
            this._state.since = null;
            const next = this._state.tasks.find(t => !t.done);
            if (next) {
                this._state.activeId = next.id;
                this._state.since = Date.now();
            }
        }
        this._save();
        const next = this._state.tasks.find(t => !t.done);
        this._renderMenu(next ? `complete:${next.id}` : 'tab:todo');
    }

    _reopen(id) {
        const task = this._state.tasks.find(t => t.id === id && t.done);
        if (!task) return;
        task.done = false;
        delete task.finishedAt;
        this._selectedTab = 'todo';
        this._save();
        this._renderMenu(`complete:${id}`);
    }

    _remove(id) {
        const index = this._state.tasks.findIndex(t => t.id === id);
        if (index < 0) return;
        if (id === this._state.activeId) {
            this._pause();
            this._state.activeId = null;
        }
        this._state.lastDeleted = {task: {...this._state.tasks[index]}, index};
        this._state.tasks.splice(index, 1);
        this._save();
        this._renderMenu('undo');
    }

    _undoDelete() {
        const deleted = this._state.lastDeleted;
        if (!deleted) return;
        if (!this._state.tasks.some(t => t.id === deleted.task.id))
            this._state.tasks.splice(Math.min(deleted.index, this._state.tasks.length), 0, deleted.task);
        this._state.lastDeleted = null;
        this._selectedTab = deleted.task.done ? 'completed' : 'todo';
        this._save();
        // Restoring a task never starts its timer or interrupts the current one.
        this._renderMenu(`complete:${deleted.task.id}`);
    }

    _add(title) {
        const normalized = title.trim();
        if (!normalized) return;
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        this._state.tasks.push({id, title: normalized.slice(0, 180), elapsed: 0, done: false});
        this._entry?.set_text('');
        this._selectedTab = 'todo';
        this._save();
        this._renderMenu('entry');
    }

    _actionButton(icon, tooltip, callback, variant = '', text = null, focusKey = null) {
        const content = new St.BoxLayout({style_class: 'tasklane-button-content'});
        if (icon) content.add_child(new St.Icon({icon_name: icon, icon_size: 16}));
        if (text) content.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
        const button = new St.Button({
            style_class: `tasklane-action ${variant}`,
            can_focus: true,
            reactive: true,
            track_hover: true,
            child: content,
        });
        button.y_align = Clutter.ActorAlign.CENTER;
        button.set_accessible_name(tooltip);
        button.connect('clicked', callback);
        this._watchFocus(button);
        if (focusKey) this._focusTargets.set(focusKey, button);
        return button;
    }

    _titleLabel(text, styleClass) {
        const label = new St.Label({text, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: styleClass});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        return label;
    }

    _selectTab(tab, animate = false) {
        const changed = this._selectedTab !== tab;
        this._closeTaskOptions();
        this._selectedTab = tab;
        this._todoList.actor.visible = tab === 'todo';
        this._completedList.actor.visible = tab === 'completed';
        for (const [name, button] of Object.entries(this._tabButtons))
            button.checked = name === tab;
        this._listScroll.vadjustment.value = 0;
        this._syncTaskReveals(false);
        if (animate && changed) {
            const incoming = tab === 'todo' ? this._todoList.actor : this._completedList.actor;
            this._animateSwitch(incoming, 140, 180);
        }
    }

    _animateSwitch(actor, duration, initialOpacity) {
        // State is already committed. Repeated clicks replace only the motion.
        actor.remove_transition('opacity');
        actor.opacity = 255;
        if (!St.Settings.get().enable_animations || !actor.mapped) return;
        actor.opacity = initialOpacity;
        actor.ease({opacity: 255, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _stopSwitchAnimations() {
        for (const actor of [this._indicator?.menu.box, this._todoList?.actor, this._completedList?.actor, this._taskView?.actor, this._settingsView?.actor]) {
            if (!actor) continue;
            actor.remove_transition('opacity');
            actor.opacity = 255;
        }
    }

    _setTheme(theme) {
        if (!['system', 'light', 'dark'].includes(theme)) return;
        this._state.theme = theme;
        this._applyTheme();
        this._animateSwitch(this._indicator.menu.box, 180, 205);
        this._save();
    }

    _setSettingsOpen(open, restoreFocus = true) {
        this._settingsOpen = open;
        if (!this._taskView || !this._settingsView) return;
        this._closeTaskOptions();
        this._taskView.actor.visible = !open;
        this._settingsView.actor.visible = open;
        this._syncTaskReveals(false);
        if (!restoreFocus || !this._indicator.menu.isOpen) return;
        const target = open ? this._settingsBack : this._settingsButton;
        target?.grab_key_focus();
        this._animateSwitch(open ? this._settingsView.actor : this._taskView.actor, 140, 205);
    }

    _applyTheme() {
        const preference = this._state.theme ?? 'system';
        const dark = preference === 'dark' || (preference === 'system' && this._interfaceSettings?.get_string('color-scheme') === 'prefer-dark');
        const box = this._indicator.menu.box;
        if (dark) box.add_style_class_name('tasklane-dark');
        else box.remove_style_class_name('tasklane-dark');
        if (this._a11ySettings?.get_boolean('high-contrast')) box.add_style_class_name('tasklane-high-contrast');
        else box.remove_style_class_name('tasklane-high-contrast');
        for (const [theme, button] of Object.entries(this._themeChoices ?? {})) button.checked = theme === preference;
    }

    _completionButton(task) {
        const button = this._actionButton('object-select-symbolic',
            `${task.title}, completed`, () => task.done ? this._reopen(task.id) : this._complete(task.id),
            'tasklane-complete', null, `complete:${task.id}`);
        const mark = new St.BoxLayout({
            style_class: `tasklane-completion-mark${task.done ? ' tasklane-completion-mark-done' : ''}`,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
        });
        mark.add_child(new St.Icon({icon_name: 'object-select-symbolic', icon_size: 12,
            opacity: task.done ? 255 : 0, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
        button.child = mark;
        button.accessible_role = Atk.Role.CHECK_BOX;
        button.toggle_mode = true;
        button.checked = task.done;
        return button;
    }

    _restoreFocus(key) {
        if (!this._indicator.menu.isOpen) return;
        const previous = this._focusTargets.get(key);
        const target = this._settingsOpen
            ? previous && this._settingsView.actor.contains(previous) ? previous : this._settingsBack
            : previous ?? this._tabButtons[this._selectedTab];
        target?.grab_key_focus();
    }

    _watchFocus(actor) {
        actor.connect('key-focus-in', () => this._scrollFocusIntoView(actor));
        // A restored control may receive focus before its first allocation.
        actor.connect('notify::allocation', () => {
            if (actor.has_key_focus()) this._scrollFocusIntoView(actor);
        });
    }

    _syncTaskReveals(animate = true) {
        const focus = global.stage.get_key_focus();
        for (const reveal of this._taskReveals?.values() ?? []) {
            const show = !!(this._indicator?.menu.isOpen && !this._settingsOpen &&
                this._selectedTab === 'todo' && (reveal.row.hover || (focus && reveal.row.contains(focus))));
            this._setTaskReveal(reveal, show, animate);
        }
    }

    _setTaskReveal(reveal, show, animate) {
        if (reveal.shown === show && animate) return;
        reveal.shown = show;
        const {row, action} = reveal;
        // The clipped action slot stays allocated even when its icon is hidden.
        // Neither the fade nor the slide changes the title's available space.
        action.reactive = show;
        if (show) row.add_style_class_name('tasklane-task-revealed');
        else row.remove_style_class_name('tasklane-task-revealed');
        action.remove_transition('opacity');
        action.remove_transition('translation-x');
        const target = {opacity: show ? 255 : 0, translation_x: show ? 0 : 7};
        if (animate && action.mapped && St.Settings.get().enable_animations) {
            action.ease({...target, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            action.opacity = target.opacity;
            action.translation_x = target.translation_x;
        }
    }

    _resetTaskReveals() {
        for (const reveal of this._taskReveals?.values() ?? [])
            this._setTaskReveal(reveal, false, false);
    }

    _scrollFocusIntoView(actor) {
        const scroll = this._listScroll;
        if (!scroll?.contains(actor) || !actor.has_allocation()) return;
        const box = actor.get_allocation_box();
        let top = box.y1;
        let bottom = box.y2;
        for (let parent = actor.get_parent(); parent && parent !== scroll; parent = parent.get_parent()) {
            if (!parent.has_allocation()) return;
            const offset = parent.get_allocation_box().y1;
            top += offset;
            bottom += offset;
        }
        const adjustment = scroll.vadjustment;
        if (adjustment.page_size <= 0) return;
        if (top < adjustment.value) adjustment.value = Math.max(0, top);
        else if (bottom > adjustment.value + adjustment.page_size)
            adjustment.value = Math.max(0, bottom - adjustment.page_size);
    }

    _closeTaskOptions() {
        for (const {button, row} of this._taskOptions?.values() ?? []) {
            button.checked = false;
            button.remove_accessible_state(Atk.StateType.EXPANDED);
            row.visible = false;
        }
    }

    _toggleTaskOptions(id) {
        const options = this._taskOptions.get(id);
        const show = !options.row.visible;
        this._closeTaskOptions();
        options.row.visible = show;
        options.button.checked = show;
        if (show) options.button.add_accessible_state(Atk.StateType.EXPANDED);
    }

    _appendTaskOptions(section, row, task) {
        const button = this._actionButton('view-more-symbolic', `More options for ${task.title}`, () => this._toggleTaskOptions(task.id), 'tasklane-more', null, `more:${task.id}`);
        button.toggle_mode = true;
        row.add_child(button);
        const actions = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        actions.add_style_class_name('tasklane-task-options');
        actions.visible = false;
        actions.add_child(this._actionButton('edit-delete-symbolic', `Delete ${task.title}`, () => this._remove(task.id), 'tasklane-delete', 'Delete'));
        section.addMenuItem(actions);
        this._taskOptions.set(task.id, {button, row: actions});
    }

    _handleMenuKeyPress(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            const expanded = [...(this._taskOptions?.values() ?? [])].find(options => options.row.visible);
            if (this._settingsOpen) {
                this._setSettingsOpen(false);
                return Clutter.EVENT_STOP;
            }
            if (expanded) {
                this._closeTaskOptions();
                expanded.button.grab_key_focus();
                return Clutter.EVENT_STOP;
            }
        }
        const modifiers = event.get_state();
        if (!(modifiers & Clutter.ModifierType.CONTROL_MASK) ||
            (modifiers & (Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK)))
            return Clutter.EVENT_PROPAGATE;
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_n || key === Clutter.KEY_N) {
            if (this._settingsOpen) this._setSettingsOpen(false, false);
            this._entry.grab_key_focus();
        } else if (key === Clutter.KEY_z || key === Clutter.KEY_Z) {
            const focused = global.stage.get_key_focus();
            if ((focused && this._entry.contains(focused)) || (modifiers & Clutter.ModifierType.SHIFT_MASK))
                return Clutter.EVENT_PROPAGATE;
            this._undoDelete();
        } else if (key === Clutter.KEY_space) {
            this._toggle();
        } else if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            const active = this._active();
            if (active) this._complete(active.id);
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    _renderMenu(focusKey = null) {
        const menu = this._indicator.menu;
        const draft = this._entry?.get_text() ?? '';
        const focused = global.stage.get_key_focus();
        focusKey ??= [...(this._focusTargets?.entries() ?? [])].find(([, actor]) => focused && actor.contains(focused))?.[0];
        this._focusTargets = new Map();
        this._resetTaskReveals();
        this._taskReveals = new Map();
        this._stopSwitchAnimations();
        menu.removeAll();
        menu.box.add_style_class_name('tasklane-menu');
        this._taskView = new PopupMenu.PopupMenuSection();
        this._settingsView = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._taskView);
        menu.addMenuItem(this._settingsView);
        const tasksMenu = this._taskView;
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        header.add_style_class_name('tasklane-header');
        header.add_child(new St.Label({text: 'Taskslane', x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'tasklane-brand'}));
        this._settingsButton = this._actionButton('emblem-system-symbolic', 'Settings',
            () => this._setSettingsOpen(true), '', null, 'settings');
        header.add_child(this._settingsButton);
        tasksMenu.addMenuItem(header);
        this._buildSettingsView();
        this._applyTheme();

        const active = this._active();
        const running = active && this._state.since !== null;
        const open = this._state.tasks.filter(t => !t.done);
        const timerRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        timerRow.add_style_class_name('tasklane-timer-row');
        if (!active) timerRow.add_style_class_name('tasklane-timer-idle');
        const summary = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tasklane-focus-summary'});
        summary.add_child(this._titleLabel(active?.title ?? 'No active task', 'tasklane-current'));
        const timerDetails = new St.BoxLayout({style_class: 'tasklane-timer-details'});
        this._durationLabel = new St.Label({text: active ? secondsToText(this._elapsed(active)) : '00:00:00', style_class: 'tasklane-clock', y_align: Clutter.ActorAlign.CENTER});
        timerDetails.add_child(this._durationLabel);
        this._statusLabel = new St.Label({text: active ? running ? 'Running' : 'Paused' : 'Ready', style_class: 'tasklane-timer-state', y_align: Clutter.ActorAlign.CENTER});
        timerDetails.add_child(this._statusLabel);
        summary.add_child(timerDetails);
        timerRow.add_child(summary);
        const playback = this._playbackLabel(active);
        this._timerControl = this._actionButton(null,
            active ? `${playback} ${active.title}` : open.length ? 'Start first task' : 'Add a task to start tracking',
            () => this._toggle('timer'), 'tasklane-timer-control', playback, 'timer');
        this._timerControl.reactive = open.length > 0;
        this._timerControl.can_focus = open.length > 0;
        if (!open.length) this._timerControl.add_style_pseudo_class('disabled');
        timerRow.add_child(this._timerControl);
        tasksMenu.addMenuItem(timerRow);

        const done = this._state.tasks.filter(t => t.done);
        const tabsRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        tabsRow.add_style_class_name('tasklane-tabs-row');
        const tabs = new St.BoxLayout({x_expand: true, style_class: 'tasklane-tabs'});
        this._tabButtons = {};
        for (const [name, title, count] of [['todo', 'To do', open.length], ['completed', 'Completed', done.length]]) {
            const button = new St.Button({
                label: `${title} · ${count}`,
                style_class: 'tasklane-tab',
                can_focus: true, reactive: true, track_hover: true,
                toggle_mode: true, checked: (this._selectedTab ?? 'todo') === name,
                x_expand: true,
            });
            button.set_accessible_name(`${title}, ${count} tasks`);
            button.connect('clicked', () => this._selectTab(name, true));
            this._tabButtons[name] = button;
            this._focusTargets.set(`tab:${name}`, button);
            tabs.add_child(button);
        }
        tabsRow.add_child(tabs);
        tasksMenu.addMenuItem(tabsRow);

        this._taskOptions = new Map();
        const lists = new PopupMenu.PopupMenuSection();
        const completed = new PopupMenu.PopupMenuSection();
        this._todoList = lists;
        this._completedList = completed;
        const listBox = new St.BoxLayout({vertical: true, x_expand: true});
        listBox.add_child(lists.actor);
        listBox.add_child(completed.actor);
        const scroll = new St.ScrollView({style_class: 'tasklane-scroll', overlay_scrollbars: true, x_expand: true});
        this._listScroll = scroll;
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        scroll.set_child(listBox);
        const listRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        listRow.add_style_class_name('tasklane-list-container');
        listRow.add_child(scroll);
        tasksMenu.addMenuItem(listRow);
        // Each tab scrolls within the compact popup.
        for (const task of open) {
            const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            row.add_style_class_name('tasklane-task-row');
            // Enable pointer tracking after construction so the row itself never
            // gains PopupBaseMenuItem's activation/completion behavior.
            row.reactive = true;
            row.track_hover = true;
            row.connect('notify::hover', () => this._syncTaskReveals());
            const isActive = task.id === active?.id;
            if (isActive) row.add_style_class_name('tasklane-task-active');
            row.add_child(this._completionButton(task));
            const details = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tasklane-task-details'});
            details.add_child(this._titleLabel(task.title, 'tasklane-task'));
            row.add_child(details);
            const action = this._playbackLabel(task);
            const playback = this._actionButton(action === 'Pause' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
                `${action} ${task.title}`, () => this._activateTask(task.id, `play:${task.id}`),
                'tasklane-task-playback', null, `play:${task.id}`);
            playback.opacity = 0;
            playback.translation_x = 7;
            playback.reactive = false;
            const slot = new St.Widget({layout_manager: new Clutter.BinLayout(),
                clip_to_allocation: true, y_align: Clutter.ActorAlign.CENTER});
            slot.add_child(playback);
            row.add_child(slot);
            this._taskReveals.set(task.id, {row, action: playback, shown: false});
            lists.addMenuItem(row);
            this._appendTaskOptions(lists, row, task);
        }
        if (!open.length) {
            const empty = new PopupMenu.PopupMenuItem(done.length ? 'All done. Enjoy a clear list.' : 'Add your first task below.', {reactive: false});
            empty.add_style_class_name('tasklane-empty');
            lists.addMenuItem(empty);
        }
        for (const task of [...done].reverse()) {
            const row = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            row.add_style_class_name('tasklane-completed-row');
            row.add_child(this._completionButton(task));
            const details = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'tasklane-task-details'});
            details.add_child(this._titleLabel(task.title, 'tasklane-finished'));
            details.add_child(new St.Label({text: secondsToText(task.elapsed), style_class: 'tasklane-time'}));
            row.add_child(details);
            completed.addMenuItem(row);
            this._appendTaskOptions(completed, row, task);
        }
        if (!done.length) {
            const empty = new PopupMenu.PopupMenuItem('Finished tasks will appear here.', {reactive: false});
            empty.add_style_class_name('tasklane-empty');
            completed.addMenuItem(empty);
        }
        this._selectTab(this._selectedTab ?? 'todo');
        if (this._state.lastDeleted) {
            const undoRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            undoRow.add_style_class_name('tasklane-undo');
            undoRow.add_child(this._titleLabel('Task deleted', 'tasklane-muted'));
            undoRow.add_child(this._actionButton('edit-undo-symbolic', 'Undo Delete', () => this._undoDelete(), '', 'Undo', 'undo'));
            tasksMenu.addMenuItem(undoRow);
        }
        const addRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        addRow.add_style_class_name('tasklane-add-row');
        addRow.add_child(new St.Icon({icon_name: 'list-add-symbolic', icon_size: 16, style_class: 'tasklane-muted', y_align: Clutter.ActorAlign.CENTER}));
        const entry = new St.Entry({text: draft, hint_text: 'Add a task…', can_focus: true, x_expand: true, style_class: 'tasklane-entry'});
        this._entry = entry;
        this._focusTargets.set('entry', entry);
        this._watchFocus(entry);
        entry.set_accessible_name('New task. Press Enter to add.');
        entry.clutter_text.connect('activate', () => this._add(entry.get_text()));
        addRow.add_child(entry);
        tasksMenu.addMenuItem(addRow);
        this._setSettingsOpen(this._settingsOpen, false);
        this._refreshLabels();
        this._restoreFocus(focusKey);
    }

    _buildSettingsView() {
        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        header.add_style_class_name('tasklane-header');
        this._settingsBack = this._actionButton('go-previous-symbolic', 'Back to Tasks', () => this._setSettingsOpen(false), '', null, 'settings-back');
        header.add_child(this._settingsBack);
        header.add_child(new St.Label({text: 'Settings', style_class: 'tasklane-brand', y_align: Clutter.ActorAlign.CENTER}));
        this._settingsView.addMenuItem(header);
        const heading = new PopupMenu.PopupMenuItem('Appearance', {reactive: false, can_focus: false});
        heading.add_style_class_name('tasklane-settings-heading');
        this._settingsView.addMenuItem(heading);
        const choices = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        choices.add_style_class_name('tasklane-appearance');
        this._themeChoices = {};
        for (const [theme, label] of [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]) {
            const button = new St.Button({label, style_class: 'tasklane-choice', can_focus: true,
                reactive: true, track_hover: true, toggle_mode: true, x_expand: true,
                accessible_role: Atk.Role.RADIO_BUTTON});
            button.set_accessible_name(`${label} appearance`);
            button.connect('clicked', () => this._setTheme(theme));
            this._watchFocus(button);
            this._focusTargets.set(`appearance:${theme}`, button);
            this._themeChoices[theme] = button;
            choices.add_child(button);
        }
        this._settingsView.addMenuItem(choices);
        const hint = new PopupMenu.PopupMenuItem('System follows your desktop appearance.', {reactive: false, can_focus: false});
        hint.add_style_class_name('tasklane-settings-hint');
        this._settingsView.addMenuItem(hint);
    }

    _refreshLabels() {
        if (!this._state || !this._panelLabel) return;
        const task = this._active();
        const running = task && this._state.since !== null;
        this._panelIcon.icon_name = task ? running ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic' : 'view-list-symbolic';
        this._panelLabel.set_text(task ? `${task.title.slice(0, 19)} · ${secondsToText(this._elapsed(task))}` : 'Tasklane');
        if (this._durationLabel) this._durationLabel.set_text(task ? secondsToText(this._elapsed(task)) : '00:00:00');
    }
}
