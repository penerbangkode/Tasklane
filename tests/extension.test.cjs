// Behavior tests with Shell actors/settings stubbed. Native rendering, Orca,
// OSK, and actual keyboard traversal still require a GNOME session.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export default class TasklaneExtension', 'globalThis.TasklaneExtension = class TasklaneExtension');

function harness(initial = {tasks: []}, legacy = null) {
    let focus = null, clock = 1000000;
    const files = new Map();
    if (initial !== null) files.set('/mock/tasklane/state.json', JSON.stringify(initial));
    if (legacy !== null) files.set('/mock/ticket-sprint/state.json', JSON.stringify(legacy));
    const settings = [], timers = new Map(), stageSignals = new Map();
    let nextSourceId = 1;
    class Actor {
        constructor(props = {}) {
            this.children = []; this.signals = {}; this.states = new Set();
            this.opacity = 255; this.mapped = true; this.visible = true;
            this.vadjustment = {value: 0};
            this.clutter_text = {connect: (name, callback) => {this.signals[name] = callback;}};
            Object.assign(this, props);
        }
        set child(value) { this.children = [value]; }
        get child() { return this.children[0]; }
        add_child(actor) { this.children.push(actor); }
        set_child(actor) { this.child = actor; }
        contains(actor) { return actor && (actor === this || this.children.some(child => child.contains(actor))); }
        set_accessible_name(name) { this.accessibleName = name; }
        add_accessible_state(state) { this.states.add(state); }
        remove_accessible_state(state) { this.states.delete(state); }
        add_style_class_name(name) { this.classes ??= new Set(); this.classes.add(name); }
        remove_style_class_name(name) { this.classes?.delete(name); }
        add_style_pseudo_class() {}
        connect(name, callback) { this.signals[name] = callback; return name; }
        set_text(text) { this.text = text; }
        get_text() { return this.text || ''; }
        set_policy() {}
        sync_hover() { this.hoverSynced = true; }
        grab_key_focus() { focus = this; stageSignals.get('notify::key-focus')?.(); }
        remove_transition(name) { (this.removedTransitions ??= []).push(name); this.animation = null; }
        ease(options) { this.animation = options; }
        destroy() { this.children = []; }
    }
    class Menu {
        constructor() { this.actor = new Actor(); this.box = this.actor; this.items = []; this.isOpen = true; this.signals = {}; }
        addMenuItem(item) { this.items.push(item); this.actor.add_child(item.actor || item); }
        removeAll() { this.items = []; this.actor.children = []; }
        connect(name, callback) { this.signals[name] = callback; return name; }
    }
    class Settings {
        constructor({schema_id}) {
            this.schema = schema_id; this.handlers = new Map();
            this.values = {'color-scheme': 'prefer-dark', 'high-contrast': false}; settings.push(this);
        }
        connect(name, callback) { this.handlers.set(name, callback); return name; }
        disconnect(id) { this.handlers.delete(id); }
        get_string(name) { return this.values[name]; }
        get_boolean(name) { return this.values[name]; }
        change(name, value) { this.values[name] = value; this.handlers.get(`changed::${name}`)?.(); }
    }
    const context = {
        St: {Widget: Actor, BoxLayout: Actor, Icon: Actor, Label: Actor, Button: Actor, Entry: Actor, ScrollView: Actor,
            Settings: {get: () => ({enable_animations: context.animate})}, PolicyType: {NEVER: 2, AUTOMATIC: 1}},
        PopupMenu: {PopupBaseMenuItem: Actor, PopupMenuSection: Menu, PopupMenuItem: class extends Actor {
            constructor(text, props) { super({...props, text}); }
        }},
        PanelMenu: {Button: class extends Actor { constructor() { super(); this.menu = new Menu(); } }},
        Main: {panel: {addToStatusArea() {}}},
        Clutter: {BinLayout: class {}, ActorAlign: {CENTER: 1}, EventType: {KEY_PRESS: 1}, AnimationMode: {EASE_OUT_QUAD: 2},
            ModifierType: {CONTROL_MASK: 4, MOD1_MASK: 8, SUPER_MASK: 64, SHIFT_MASK: 1},
            KEY_n: 110, KEY_N: 78, KEY_z: 122, KEY_Z: 90, KEY_space: 32, KEY_Return: 13, KEY_KP_Enter: 14, KEY_Escape: 27,
            EVENT_STOP: true, EVENT_PROPAGATE: false},
        Atk: {Role: {CHECK_BOX: 1, RADIO_BUTTON: 2}, StateType: {EXPANDED: 1}},
        Pango: {EllipsizeMode: {END: 3}}, Extension: class {},
        Gio: {Settings, FileCreateFlags: {REPLACE_DESTINATION: 1}, File: {new_for_path: filename => ({
            query_exists: () => files.has(filename),
            load_contents: () => {
                assert(files.has(filename), `Missing state: ${filename}`);
                return [true, new TextEncoder().encode(files.get(filename))];
            },
            replace_contents: bytes => { files.set(filename, new TextDecoder().decode(bytes)); },
        })}},
        GLib: {build_filenamev: parts => parts.join('/'), get_user_data_dir: () => '/mock',
            path_get_dirname: () => '/mock', mkdir_with_parents() {}, PRIORITY_DEFAULT: 0,
            timeout_add_seconds: (_priority, _interval, callback) => {const id = nextSourceId++; timers.set(id,callback); return id;},
            Source: {remove: id => timers.delete(id)}, SOURCE_CONTINUE: true},
        global: {stage: {get_key_focus: () => focus,
            connect: (name, callback) => {stageSignals.set(name, callback); return name;},
            disconnect: name => stageSignals.delete(name)}},
        Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } },
        TextEncoder, TextDecoder, console, animate: true,
    };
    vm.runInNewContext(source, context);
    const ext = new context.TasklaneExtension(); ext.enable();
    const walk = (actor = ext._indicator.menu.actor) => [actor, ...actor.children.flatMap(child => walk(child))];
    const click = name => {const actor = walk().find(a => a.accessibleName === name); assert(actor, name); actor.signals.clicked();};
    const key = (symbol, modifiers = 4) => ext._handleMenuKeyPress({get_key_symbol: () => symbol, get_state: () => modifiers});
    return {ext, context, settings, timers, stageSignals, files, click, walk, key, get focus() {return focus;},
        disk: () => JSON.parse(files.get('/mock/tasklane/state.json')), advance: milliseconds => {clock += milliseconds;}, tick: () => {for (const callback of timers.values()) callback();}};
}
const task = (id, done = false) => ({id, title: `Task ${id}`, elapsed: 20, done});

test('storage migrates legacy tasks, timer, appearance and Undo once without modifying the backup', () => {
    const legacy = {tasks: [task('a'), task('b', true)], activeId: 'a', since: 990000,
        theme: 'dark', lastDeleted: {task: task('c'), index: 1}};
    const h = harness(null, legacy);
    assert.equal(h.ext._path, '/mock/tasklane/state.json');
    assert.deepEqual(h.disk(), legacy);
    assert.equal(h.files.get('/mock/ticket-sprint/state.json'), JSON.stringify(legacy));
    assert.equal(h.ext._elapsed(h.ext._active()), 30);
    h.ext._pause();
    h.ext._state.tasks[0].title = 'Updated task'; h.ext._save();
    const loaded = h.ext._load();
    assert.equal(loaded.tasks[0].title, 'Updated task');
    assert.equal(loaded.tasks[0].elapsed, 30);
    assert.equal(loaded.since, null);
    assert.equal(h.files.get('/mock/ticket-sprint/state.json'), JSON.stringify(legacy));
});

test('existing Tasklane state takes precedence over legacy data, including an empty list', () => {
    const h = harness({tasks: []}, {tasks: [task('old')]});
    assert.equal(h.ext._state.tasks.length, 0);
    assert.deepEqual(h.disk(), {tasks: []});
});

test('fresh installs save to Tasklane and invalid legacy state is not migrated', () => {
    const h = harness(null);
    assert.equal(h.ext._state.tasks.length, 0);
    h.ext._save();
    assert(h.files.has('/mock/tasklane/state.json'));
    assert(!h.files.has('/mock/ticket-sprint/state.json'));
    const invalid = harness(null, {tasks: 'invalid'});
    assert.equal(invalid.ext._state.tasks.length, 0);
    assert(!invalid.files.has('/mock/tasklane/state.json'));
});

function hover(reveal, value) {
    reveal.row.hover = value;
    reveal.row.signals['notify::hover']();
}

test('ghost playback reserves a separate clipped slot without covering the title on hover', () => {
    const h = harness({tasks: [task('a'), task('b', true)]});
    const reveal = h.ext._taskReveals.get('a');
    const {row, action} = reveal;
    assert.equal(row.children.length, 4); // Checkbox, title, action slot, overflow.
    const details = row.children[1], slot = row.children[2];
    assert(slot.layout_manager instanceof h.context.Clutter.BinLayout);
    assert.equal(slot.clip_to_allocation, true);
    assert.equal(slot.children.length, 1);
    assert.equal(slot.children[0], action);
    assert.equal(details.contains(action), false);
    assert.equal(details.children[0].text, 'Task a');
    assert.equal(action.child.children.length, 1); // Icon only: no persistent label.
    assert.equal(action.child.children[0].icon_name, 'media-playback-start-symbolic');
    assert.equal(row.children[3], h.ext._focusTargets.get('more:a'));
    assert.equal(action.opacity, 0); assert.equal(action.translation_x, 7);
    assert.equal(action.reactive, false); assert.equal(action.visible, true);
    const children = [...row.children];
    hover(reveal, true);
    assert.deepEqual(row.children, children);
    assert.equal(action.animation.opacity, 255);
    assert.equal(action.animation.translation_x, 0);
    assert.equal(action.animation.duration, 140);
    assert.equal(action.animation.mode, h.context.Clutter.AnimationMode.EASE_OUT_QUAD);
    assert(row.classes.has('tasklane-task-revealed'));
    assert.equal(action.reactive, true);
    assert.equal(h.ext._focusTargets.get('more:a').reactive, true);
    assert.equal(h.ext._taskReveals.has('b'), false);
});

test('rapid pointer reversals replace motion from its current values without stale callbacks', () => {
    const h = harness({tasks: [task('a')]});
    const reveal = h.ext._taskReveals.get('a'), {action} = reveal;
    for (let i = 0; i < 8; i++) {
        hover(reveal, true);
        // Simulate a partially completed native transition.
        action.opacity = 120; action.translation_x = 3;
        hover(reveal, false);
        assert.equal(action.opacity, 120); assert.equal(action.translation_x, 3);
        assert.equal(action.animation.opacity, 0); assert.equal(action.animation.translation_x, 7);
        assert.equal(action.reactive, false);
        hover(reveal, true);
        assert.equal(action.opacity, 120); assert.equal(action.translation_x, 3);
        assert.equal(action.animation.opacity, 255);
        assert.equal(action.animation.onComplete, undefined);
        hover(reveal, false);
    }
    assert(action.removedTransitions.includes('opacity'));
    assert(action.removedTransitions.includes('translation-x'));
    assert(!reveal.row.classes.has('tasklane-task-revealed'));
});

test('keyboard focus reveals task action and persists across checkbox/action/overflow traversal', () => {
    const h = harness({tasks: [task('a')]});
    const reveal = h.ext._taskReveals.get('a');
    for (const key of ['complete:a', 'play:a', 'more:a']) {
        h.ext._focusTargets.get(key).grab_key_focus();
        assert.equal(reveal.shown, true);
        assert.equal(reveal.action.can_focus, true);
        assert.equal(reveal.action.reactive, true);
        hover(reveal, false);
        assert.equal(reveal.shown, true);
    }
    h.click('More options for Task a');
    assert.equal(h.ext._taskOptions.get('a').row.visible, true);
    h.ext._entry.grab_key_focus();
    assert.equal(reveal.shown, false);
    assert.equal(reveal.action.animation.opacity, 0);
});

test('ghost icon clicks start, switch, pause and resume without completing tasks or opening options', () => {
    const h = harness({tasks: [{...task('a'), elapsed: 0}, task('b')]});
    const press = id => {
        const reveal = h.ext._taskReveals.get(id);
        hover(reveal, true);
        assert.equal(reveal.action.reactive, true);
        reveal.action.signals.clicked();
        assert(h.ext._state.tasks.every(t => !t.done));
        assert([...h.ext._taskOptions.values()].every(options => !options.row.visible));
        assert.equal(h.timers.size, 1);
    };
    assert.equal(h.ext._taskReveals.get('a').action.accessibleName, 'Start Task a');
    press('a'); h.advance(5000);
    assert.equal(h.ext._taskReveals.get('a').action.accessibleName, 'Pause Task a');
    assert.equal(h.ext._taskReveals.get('a').action.child.children[0].icon_name, 'media-playback-pause-symbolic');
    press('b');
    assert.equal(h.ext._state.tasks[0].elapsed, 5);
    assert.equal(h.ext._active().id, 'b');
    assert.equal(h.ext._taskReveals.get('a').action.accessibleName, 'Resume Task a');
    h.advance(3000); press('b');
    assert.equal(h.ext._state.since, null);
    assert.equal(h.ext._state.tasks[1].elapsed, 23);
    press('a');
    assert.equal(h.ext._active().id, 'a');
    assert.equal(h.focus, h.ext._taskReveals.get('a').action);
    assert.equal(h.ext._taskReveals.get('a').shown, true);
});

test('close/reopen, view changes, rebuild and disable reset ghost action motion; reduced motion is immediate', () => {
    const h = harness({tasks: [task('a')]});
    let reveal = h.ext._taskReveals.get('a');
    hover(reveal, true);
    const menu = h.ext._indicator.menu;
    menu.isOpen = false; menu.signals['open-state-changed'](menu, false);
    assert.equal(reveal.action.animation, null);
    assert.equal(reveal.action.opacity, 0); assert.equal(reveal.action.translation_x, 7);
    assert.equal(reveal.action.reactive, false);
    reveal.row.hover = false;
    menu.isOpen = true; menu.signals['open-state-changed'](menu, true);
    assert.equal(reveal.row.hoverSynced, true);
    assert.equal(reveal.action.opacity, 0); assert.equal(reveal.action.animation, null);
    h.context.animate = false;
    hover(reveal, true);
    assert.equal(reveal.action.opacity, 255); assert.equal(reveal.action.translation_x, 0);
    assert.equal(reveal.action.animation, null);
    h.ext._selectTab('completed'); assert.equal(reveal.action.opacity, 0);
    h.ext._selectTab('todo'); assert.equal(reveal.action.opacity, 255);
    h.ext._setSettingsOpen(true); assert.equal(reveal.action.opacity, 0);
    h.ext._setSettingsOpen(false);
    h.ext._renderMenu();
    assert.equal(reveal.action.opacity, 0); assert.equal(reveal.action.animation, null);
    reveal = h.ext._taskReveals.get('a');
    hover(reveal, true);
    h.ext.disable();
    assert.equal(reveal.action.opacity, 0); assert.equal(reveal.action.animation, null);
    assert.equal(h.stageSignals.size, 0);
    h.ext.enable(); assert.equal(h.stageSignals.size, 1);
});

test('appearance follows system changes; explicit choice stays; defaults migrate safely', () => {
    const h = harness();
    assert.equal(h.ext._state.theme, 'system');
    assert(h.ext._indicator.menu.box.classes.has('tasklane-dark'));
    h.settings[0].change('color-scheme', 'default');
    assert(!h.ext._indicator.menu.box.classes.has('tasklane-dark'));
    h.click('Settings'); assert(h.ext._settingsView.actor.visible);
    assert.equal(h.ext._taskView.actor.visible, false);
    h.click('Light appearance');
    h.settings[0].change('color-scheme', 'prefer-dark');
    assert(!h.ext._indicator.menu.box.classes.has('tasklane-dark'));
    assert.equal(h.disk().theme, 'light');
    assert.equal(h.ext._themeChoices.light.checked, true);
    h.click('Dark appearance'); assert(h.ext._indicator.menu.box.classes.has('tasklane-dark'));
    assert.equal(harness({tasks: [], theme:'light'}).ext._state.theme, 'light');
    assert.equal(harness({tasks: [], theme:'invalid'}).ext._state.theme, 'system');
});

test('completion advances timer; checked task can reopen without affecting active timer', () => {
    const h = harness({tasks: [task('a'), task('b')]});
    h.click('Resume Task a'); h.advance(5000);
    h.click('Task a, completed');
    assert.equal(h.ext._active().id, 'b');
    assert.equal(h.ext._state.tasks[0].elapsed, 25);
    assert.equal(h.focus, h.ext._focusTargets.get('complete:b'));
    h.click('Completed, 1 tasks');
    const checkbox = h.ext._focusTargets.get('complete:a');
    assert.equal(checkbox.checked, true); assert.equal(checkbox.accessible_role, 1);
    const since = h.ext._state.since;
    h.click('Task a, completed');
    assert.equal(h.ext._selectedTab, 'todo');
    assert.equal(h.ext._active().id, 'b'); assert.equal(h.ext._state.since, since);
    assert.equal(h.ext._state.tasks[0].done, false);
    assert.equal(h.ext._state.tasks[0].finishedAt, undefined);
    assert.equal(h.focus, h.ext._focusTargets.get('complete:a'));
});

test('delete active task preserves elapsed time; Undo restores order without auto-starting', () => {
    const h = harness({tasks: [task('a'), task('b'), task('c')]});
    h.click('Resume Task b'); h.advance(7000);
    h.click('More options for Task b'); h.click('Delete Task b');
    assert.equal(h.ext._state.activeId, null); assert.equal(h.ext._state.since, null);
    assert.equal(h.ext._state.lastDeleted.task.elapsed, 27);
    assert.equal(h.focus, h.ext._focusTargets.get('undo'));
    h.click('Undo Delete');
    assert.equal(h.ext._state.tasks.map(t => t.id).join(','), 'a,b,c');
    assert.equal(h.ext._state.tasks[1].elapsed, 27);
    assert.equal(h.ext._state.activeId, null); assert.equal(h.ext._state.since, null);
    assert.equal(h.ext._state.lastDeleted, null);
    assert.equal(h.focus, h.ext._focusTargets.get('complete:b'));
});

test('Undo survives restart, restores completed status, and never duplicates a task', () => {
    const h = harness({tasks: [task('a'), {...task('b',true), finishedAt:'2026-10-15'}]});
    h.ext._remove('b');
    const restart = harness(h.disk());
    restart.ext._undoDelete(); restart.ext._undoDelete();
    assert.equal(restart.ext._state.tasks.length, 2);
    assert.equal(restart.ext._state.tasks[1].done, true);
    assert.equal(restart.ext._state.tasks[1].finishedAt, '2026-10-15');
    assert.equal(restart.ext._selectedTab, 'completed');
    assert.equal(restart.ext._state.activeId, null);
});

test('only the latest deletion is undoable; restoring does not interrupt running task', () => {
    const h = harness({tasks: [task('a'),task('b'),task('c')]});
    h.click('Resume Task a'); const since = h.ext._state.since;
    h.ext._remove('b'); h.ext._remove('c'); h.ext._undoDelete();
    assert.equal(h.ext._state.tasks.map(t=>t.id).join(','), 'a,c');
    assert.equal(h.ext._active().id, 'a'); assert.equal(h.ext._state.since, since);
});

test('draft and keyboard focus survive timer operations and appearance changes', () => {
    const h = harness({tasks: [task('a')]});
    h.click('Resume Task a');
    assert.equal(h.focus, h.ext._focusTargets.get('play:a'));
    h.ext._entry.set_text('Draft'); h.ext._entry.grab_key_focus();
    h.key(32);
    assert.equal(h.focus, h.ext._entry); assert.equal(h.ext._entry.get_text(), 'Draft');
    const entry = h.ext._entry;
    h.click('Settings'); h.click('Dark appearance'); h.click('Back to Tasks');
    assert.equal(h.ext._entry, entry); assert.equal(h.ext._entry.get_text(), 'Draft');
    h.ext._entry.signals.activate();
    assert.equal(h.focus, h.ext._entry); assert.equal(h.ext._entry.get_text(), '');
    assert.equal(h.ext._state.tasks.at(-1).title, 'Draft');
});

test('Ctrl+Z leaves text undo and redo alone; otherwise restores last deletion', () => {
    const h = harness({tasks:[task('a')]}); h.ext._remove('a');
    h.ext._entry.grab_key_focus();
    assert.equal(h.key(122), false); assert(h.ext._state.lastDeleted);
    h.ext._settingsButton.grab_key_focus();
    assert.equal(h.key(122,5), false); assert(h.ext._state.lastDeleted);
    assert.equal(h.key(122), true); assert.equal(h.ext._state.tasks.length,1);
});

test('Escape dismisses disclosures first; high contrast tracks desktop setting', () => {
    const h = harness({tasks:[task('a')]});
    h.click('Settings'); assert.equal(h.key(27,0),true);
    assert(!h.ext._settingsView.actor.visible); assert.equal(h.focus,h.ext._settingsButton);
    h.click('More options for Task a'); assert.equal(h.key(27,0),true);
    assert.equal(h.focus,h.ext._taskOptions.get('a').button);
    assert.equal(h.key(27,0),false);
    h.settings[1].change('high-contrast',true);
    assert(h.ext._indicator.menu.box.classes.has('tasklane-high-contrast'));
    h.settings[1].change('high-contrast',false);
    assert(!h.ext._indicator.menu.box.classes.has('tasklane-high-contrast'));
});

test('motion is replaceable, reduced motion is honored, disable disconnects settings/timer', () => {
    const h = harness(); const box=h.ext._indicator.menu.box;
    h.ext._setTheme('dark'); assert.equal(box.animation.duration,180);
    h.ext._setTheme('light'); assert.equal(h.ext._state.theme,'light');
    h.context.animate=false; h.ext._setTheme('dark');
    assert.equal(box.animation,null); assert.equal(box.opacity,255);
    h.ext.disable(); assert.equal(h.timers.size,0);
    assert(h.settings.every(s=>s.handlers.size===0));
    h.settings[0].change('color-scheme','default');
});

test('focus scrolling brings a control into view and defers until allocation exists', () => {
    const h = harness();
    const scroll = h.ext._listScroll;
    scroll.vadjustment = {value: 0, page_size: 100};
    scroll.contains = () => true;
    const parent = {has_allocation: () => true, get_allocation_box: () => ({y1: 200}), get_parent: () => scroll};
    const actor = {has_allocation: () => true, get_allocation_box: () => ({y1: 10, y2: 42}), get_parent: () => parent};
    h.ext._scrollFocusIntoView(actor);
    assert.equal(scroll.vadjustment.value, 142);
    scroll.vadjustment.value = 250;
    h.ext._scrollFocusIntoView(actor);
    assert.equal(scroll.vadjustment.value, 210);
    scroll.vadjustment.value = 0; actor.has_allocation = () => false;
    h.ext._scrollFocusIntoView(actor);
    assert.equal(scroll.vadjustment.value, 0);
});

test('main timer and task controls share Start/Resume/Pause semantics', () => {
    const h = harness({tasks:[{...task('a'),elapsed:0}, {...task('b'),elapsed:0}]});
    assert.equal(h.ext._statusLabel.text,'Ready');
    assert.equal(h.ext._durationLabel.text,'00:00:00');
    h.click('Start first task');
    assert.equal(h.ext._active().id,'a'); assert.equal(h.ext._statusLabel.text,'Running');
    h.advance(5200); h.tick();
    assert.equal(h.ext._durationLabel.text,'00:00:05');
    assert(h.ext._panelLabel.text.includes('Task a · 00:00:05'));
    h.ext._timerControl.signals.clicked();
    assert.equal(h.ext._statusLabel.text,'Paused');
    assert.equal(h.ext._state.tasks[0].elapsed,5.2);
    h.ext._focusTargets.get('play:a').signals.clicked();
    assert.equal(h.ext._statusLabel.text,'Running');
    h.advance(3000); h.click('Start Task b');
    assert.equal(h.ext._active().id,'b'); assert.equal(h.ext._state.tasks[0].elapsed,8.2);
    assert.equal(h.ext._durationLabel.text,'00:00:00');
    h.advance(2000); h.click('Resume Task a');
    assert.equal(h.ext._active().id,'a'); assert.equal(h.ext._state.tasks[1].elapsed,2);
    assert.equal(h.ext._durationLabel.text,'00:00:08');
    h.advance(1000); h.tick();
    assert.equal(h.ext._elapsed(h.ext._state.tasks[0]),9.2);
    assert.equal(h.ext._elapsed(h.ext._state.tasks[1]),2);
    assert.equal(h.timers.size,1);
});

test('invalid and duplicate starts leave the running task untouched', () => {
    const h = harness({tasks:[task('a'),task('b',true)]});
    h.click('Resume Task a'); h.advance(4000);
    const since=h.ext._state.since;
    h.ext._start('missing'); h.ext._start('b'); h.ext._start('a');
    assert.equal(h.ext._active().id,'a'); assert.equal(h.ext._state.since,since);
    assert.equal(h.ext._state.tasks[0].elapsed,20);
    assert.equal(h.ext._elapsed(h.ext._active()),24);
});

test('delayed callbacks and enabled suspend/resume account for real elapsed time once', () => {
    const h = harness({tasks:[task('a')]}); h.click('Resume Task a');
    h.advance(2*60*60*1000); // No timeout callbacks while suspended.
    h.tick(); assert.equal(h.ext._durationLabel.text,'02:00:20');
    h.tick(); h.tick(); assert.equal(h.ext._durationLabel.text,'02:00:20');
    h.ext._timerControl.signals.clicked();
    assert.equal(h.ext._state.tasks[0].elapsed,7220);
    h.advance(60000); h.tick(); assert.equal(h.ext._durationLabel.text,'02:00:20');
    h.ext._timerControl.signals.clicked(); h.advance(3000); h.tick();
    assert.equal(h.ext._durationLabel.text,'02:00:23');
});

test('disable/enable (clean reload) pauses time, clears sources, and never bills disabled time', () => {
    const h = harness({tasks:[task('a')]}); h.click('Resume Task a'); h.advance(6500);
    h.ext.enable(); assert.equal(h.timers.size,1); assert.equal(h.settings.length,2);
    h.ext.disable(); assert.equal(h.timers.size,0);
    assert.equal(h.disk().tasks[0].elapsed,26.5); assert.equal(h.disk().since,null);
    h.advance(3600000); h.ext.enable();
    assert.equal(h.timers.size,1); assert.equal(h.ext._state.since,null);
    assert.equal(h.ext._statusLabel.text,'Paused'); assert.equal(h.ext._durationLabel.text,'00:00:26');
    h.click('Resume Task a'); h.advance(1500); h.tick();
    assert.equal(h.ext._durationLabel.text,'00:00:28');
    h.ext.disable(); h.ext.disable(); assert.equal(h.timers.size,0);
});

test('unclean restart recovers the saved running timestamp without double-counting', () => {
    const h = harness({tasks:[task('a')]}); h.click('Resume Task a');
    h.advance(5000); // Simulate process loss without disable().
    const restart = harness(h.disk()); restart.advance(8000); restart.tick();
    assert.equal(restart.ext._durationLabel.text,'00:00:28');
    restart.ext._timerControl.signals.clicked();
    assert.equal(restart.disk().tasks[0].elapsed,28);
    assert.equal(restart.disk().since,null);
    restart.ext.disable(); restart.ext.enable(); restart.tick();
    assert.equal(restart.ext._durationLabel.text,'00:00:28');
});

test('Settings isolates appearance controls, preserves task draft, and resets on close', () => {
    const h = harness({tasks:[task('a')]}); h.ext._entry.set_text('Draft');
    assert.equal(h.ext._settingsView.actor.visible,false);
    assert.equal(h.ext._taskView.actor.visible,true);
    const entry=h.ext._entry;
    h.click('Settings'); assert.equal(h.focus,h.ext._settingsBack);
    assert.equal(h.ext._taskView.actor.visible,false);
    h.click('Light appearance');
    assert.equal(h.ext._entry,entry); assert.equal(h.ext._entry.get_text(),'Draft');
    assert.equal(h.ext._themeChoices.light.checked,true);
    h.key(110); assert.equal(h.ext._taskView.actor.visible,true); assert.equal(h.focus,entry);
    h.click('Settings'); h.ext._indicator.menu.signals['open-state-changed'](null,false);
    assert.equal(h.ext._settingsOpen,false); assert.equal(h.ext._taskView.actor.visible,true);
});

test('completing a queued task does not change the active task timestamp', () => {
    const h=harness({tasks:[task('a'),task('b')]}); h.click('Resume Task a');
    const since=h.ext._state.since; h.advance(3000); h.click('Task b, completed');
    assert.equal(h.ext._active().id,'a'); assert.equal(h.ext._state.since,since);
    assert.equal(h.ext._elapsed(h.ext._active()),23);
    assert.equal(h.ext._state.tasks[1].elapsed,20);
});

test('malformed persisted tasks cannot create multiple active timers or invalid labels', () => {
    const h=harness({tasks:[task('a'),task('a'), {...task('b'),elapsed:'Infinity'},null],activeId:'missing',since:123});
    assert.equal(h.ext._state.tasks.length,2); assert.equal(h.ext._state.tasks[1].elapsed,0);
    assert.equal(h.ext._state.activeId,null); assert.equal(h.ext._state.since,null);
    assert.equal(h.ext._statusLabel.text,'Ready');
    const done=harness({tasks:[task('a',true)],activeId:'a',since:123});
    assert.equal(done.ext._state.activeId,null); assert.equal(done.ext._timerControl.reactive,false);
});
