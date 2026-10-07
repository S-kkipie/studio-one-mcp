// studio-one-mcp bridge component: owns the mailbox bridge (BridgeCore.js) and
// gives it the mixer through this surface's channel bank.

include_file("resource://com.presonus.musicdevices/sdk/controlsurfacecomponent.js");
include_file("BridgeConfig.js");
include_file("BridgeCore.js");

const AUTOMATION_MODES = ["off", "read", "touch", "latch", "write"];

class BridgeComponent extends PreSonus.ControlSurfaceComponent {
    onInit(hostComponent) {
        super.onInit(hostComponent);
        this.tickParam = hostComponent.paramList.addParam("bridgeTick");
        // An alias parameter can be pointed at any element's parameter to read
        // its display text (a send's destination name, a level in dB), the way
        // the FaderPort script fills its scribble strips.
        this.displayAlias = typeof hostComponent.paramList.addAlias === "function"
            ? hostComponent.paramList.addAlias("bridgeDisplay") : null;
        this.bridge = null;
        try {
            const cfg = bridgeConfig();
            if (cfg) this.bridge = new Bridge(cfg, this);
        } catch (e) {
            Host.Console.writeLine("studio-one-mcp: bridge init failed: " + e);
        }
        // Clock: the client's MIDI CC on the bridgeTick control (see the surface file).
        // Do NOT use Host.GUI.addIdleTask with a script object here: on Studio One
        // 5.5.2 that crashed the app at launch (EXC_BAD_ACCESS in cclgui's timer).
        if (this.bridge) this.bridge.beat(true); // publish clockErrors even if no clock fires
    }

    onExit() {
        if (this.bridge) this.bridge.close();
        this.bridge = null;
        super.onExit();
    }

    clockTick(source) {
        if (!this.bridge) return;
        try { this.bridge.tick(source); }
        catch (e) { Host.Console.writeLine("studio-one-mcp: tick failed: " + e); }
    }

    paramChanged(param) {
        if (param === this.tickParam) return this.clockTick("midi");
        super.paramChanged(param);
    }

    // Never throw out of a component method. Studio One wraps calls into the
    // component and turns any escaping exception into a modal "Scripting Error"
    // dialog, even when the caller has a try/catch. Failures are returned as
    // { error } values and BridgeCore.js rethrows them on its own side.
    channelElements() {
        const model = this.hostComponent && this.hostComponent.model;
        if (!model) return { error: "surface model not available" };
        const bank = model.root.find("mixer").find("channels");
        const out = [];
        for (let i = 0; i < 256; i++) {
            const el = bank.getElement(i);
            if (!el || !el.isConnected()) continue;
            const label = el.getParamValue(PreSonus.ParamID.kLabel);
            if (label !== undefined && label !== null && String(label) !== "") out.push({ index: i, el: el, label: String(label) });
        }
        return out;
    }

    readParam(el, id) {
        try { const v = el.getParamValue(id); return v === undefined ? null : v; } catch (_) { return null; }
    }

    channels() {
        const els = this.channelElements();
        if (els.error) return els;
        return els.map(c => ({
            index: c.index,
            label: c.label,
            type: this.readParam(c.el, PreSonus.ParamID.kChannelType),
            volume: this.readParam(c.el, PreSonus.ParamID.kVolume),
            pan: this.readParam(c.el, PreSonus.ParamID.kPan),
            mute: this.readParam(c.el, "mute"),
            solo: this.readParam(c.el, "solo"),
            recordArmed: this.readParam(c.el, PreSonus.ParamID.kRecord),
            automation: AUTOMATION_MODES[this.readParam(c.el, PreSonus.ParamID.kAutoMode)] || null,
            monitor: this.readParam(c.el, "monitor"),
            // Routing is a list index (-1) whose names are only display text, like
            // sendPort. Read-only: fromString with a name did not change it (5.5.2).
            input: this.readParam(c.el, "recordPort") === null ? null : this.displayOf(c.el, "recordPort"),
            output: this.readParam(c.el, "outputPort") === null ? null : this.displayOf(c.el, "outputPort"),
        }));
    }

    // Automation mode is a list parameter on the channel: 0 Off .. 4 Write
    // (checked against its display text on 5.5.2).
    setAutomation(args) {
        const mode = AUTOMATION_MODES.indexOf(args.mode);
        if (mode < 0) return { error: "mode must be one of " + AUTOMATION_MODES.join(", ") };
        const c = this.channelByLabel(args.channel);
        if (c.error) return c;
        const id = PreSonus.ParamID.kAutoMode;
        const before = AUTOMATION_MODES[this.readParam(c.el, id)] || null;
        c.el.setParamValue(id, mode);
        return { channel: args.channel, before: before, after: AUTOMATION_MODES[this.readParam(c.el, id)] || null };
    }

    // Peak meter per channel in dB (-144 is silence), both sides of a stereo strip.
    meters() {
        const els = this.channelElements();
        if (els.error) return els;
        return els.map(c => ({ label: c.label, left: this.readParam(c.el, "level1"), right: this.readParam(c.el, "level2") }));
    }

    // ---- inserts and sends ----------------------------------------------------
    //
    // Each channel strip carries two sub-banks from the surface file. Names come
    // from the bank element (@owner/deviceName, as Studio One's SDK names it);
    // bypass is the channel's own "Inserts/[i]/@bypass" parameter (used by the
    // built-in Mackie script). Every host member is checked before it is called.

    subBank(el, name) {
        if (!el || typeof el.find !== "function") return null;
        const bank = el.find(name);
        return bank && typeof bank.getElement === "function" ? bank : null;
    }

    channelByLabel(label) {
        const els = this.channelElements();
        if (els.error) return els;
        const matches = els.filter(c => c.label === label);
        if (matches.length !== 1) return { error: matches.length ? "channel name is ambiguous: " + label : "no channel named " + label };
        return matches[0];
    }

    insertsOf(el) {
        const bank = this.subBank(el, "inserts");
        const out = [];
        if (!bank) return out;
        for (let i = 0; i < 16; i++) {
            const slot = bank.getElement(i);
            if (!slot || typeof slot.isConnected !== "function" || !slot.isConnected()) continue;
            const name = this.readParam(slot, PreSonus.ParamID.kInsertName);
            if (name === null || String(name) === "") continue;
            out.push({ slot: i, name: String(name), bypassed: !!this.readParam(el, "Inserts/[" + i + "]/@bypass") });
        }
        return out;
    }

    inserts(args) {
        const els = this.channelElements();
        if (els.error) return els;
        const want = args && args.channel;
        const out = [];
        for (const c of els) {
            if (want && c.label !== want) continue;
            out.push({ channel: c.label, bypassAll: !!this.readParam(c.el, PreSonus.ParamID.kInsertBypass), inserts: this.insertsOf(c.el) });
        }
        if (want && !out.length) return { error: "no channel named " + want };
        return out;
    }

    // slot: number, or "all" for the channel's bypass-all switch.
    setInsertBypass(args) {
        const c = this.channelByLabel(args.channel);
        if (c.error) return c;
        const param = args.slot === "all" ? PreSonus.ParamID.kInsertBypass : "Inserts/[" + args.slot + "]/@bypass";
        if (args.slot !== "all") {
            const slot = this.insertsOf(c.el).find(x => x.slot === args.slot);
            if (!slot) return { error: "no plug-in in slot " + args.slot + " on " + args.channel };
        }
        const before = this.readParam(c.el, param);
        c.el.setParamValue(param, args.bypassed ? 1 : 0);
        return { channel: args.channel, slot: args.slot, before: !!before, after: !!this.readParam(c.el, param) };
    }

    displayOf(el, paramName) {
        const a = this.displayAlias;
        if (!a || !el || typeof el.connectAliasParam !== "function") return null;
        el.connectAliasParam(a, paramName);
        return typeof a.string === "string" ? a.string : null;
    }

    sendsOf(el) {
        const bank = this.subBank(el, "sends");
        const out = [];
        if (!bank) return out;
        for (let i = 0; i < 8; i++) {
            const send = bank.getElement(i);
            if (!send || typeof send.isConnected !== "function" || !send.isConnected()) continue;
            if (this.readParam(send, PreSonus.ParamID.kSendPort) === null) continue;
            out.push({
                index: i,
                to: this.displayOf(send, PreSonus.ParamID.kSendPort),
                level: this.readParam(send, PreSonus.ParamID.kSendLevel),
                levelDb: this.displayOf(send, PreSonus.ParamID.kSendLevel),
                muted: !!this.readParam(send, PreSonus.ParamID.kSendMute),
            });
        }
        return out;
    }

    sends(args) {
        const els = this.channelElements();
        if (els.error) return els;
        const want = args && args.channel;
        const out = [];
        for (const c of els) {
            if (want && c.label !== want) continue;
            const s = this.sendsOf(c.el);
            if (want || s.length) out.push({ channel: c.label, sends: s });
        }
        if (want && !out.length) return { error: "no channel named " + want };
        return out;
    }

    setSend(args) {
        const c = this.channelByLabel(args.channel);
        if (c.error) return c;
        const bank = this.subBank(c.el, "sends");
        const send = bank ? bank.getElement(args.index) : null;
        if (!send || !this.sendsOf(c.el).some(x => x.index === args.index)) return { error: "no send " + args.index + " on " + args.channel };
        const out = { channel: args.channel, index: args.index };
        if (args.level !== undefined) {
            if (typeof args.level !== "number" || args.level < 0 || args.level > 1) return { error: "level must be 0..1 (Studio One's normalised send level)" };
            send.setParamValue(PreSonus.ParamID.kSendLevel, args.level);
        }
        if (args.muted !== undefined) send.setParamValue(PreSonus.ParamID.kSendMute, args.muted ? 1 : 0);
        out.send = this.sendsOf(c.el).find(x => x.index === args.index);
        return out;
    }

    // ---- channel name and colour ------------------------------------------------
    //
    // A track's own name and colour are read-only to scripts, but setting its
    // channel's label / colour renames and recolours the track too (5.5.2). Colour
    // is ARGB as a signed 32-bit number. Neither change is on the undo stack.

    setChannelLabel(args) {
        const c = this.channelByLabel(args.channel);
        if (c.error) return c;
        if (typeof args.name !== "string" || args.name === "") return { error: "name must be a non-empty string" };
        c.el.setParamValue(PreSonus.ParamID.kLabel, args.name);
        return { before: args.channel, after: String(this.readParam(c.el, PreSonus.ParamID.kLabel)) };
    }

    setChannelColor(args) {
        const c = this.channelByLabel(args.channel);
        if (c.error) return c;
        if (typeof args.argb !== "number") return { error: "argb must be a number" };
        const id = PreSonus.ParamID.kColor || "color";
        const before = this.readParam(c.el, id);
        c.el.setParamValue(id, args.argb);
        return { channel: args.channel, before: before, after: this.readParam(c.el, id) };
    }

    // ---- plug-in parameters -----------------------------------------------------
    //
    // An insert slot's component ("FX01") has a child component "Device": the
    // plug-in itself. Its parameters are found by name ("comp.threshold" on the
    // Fat Channel, "lffreq" on the Pro EQ) and give value, display text, range and
    // a normalised value. The host cannot list them, so the server sends the names
    // (from the plug-in's presets); unknown names come back as null, never throw.

    // Either target shape: { channel, slot } (an insert) or { instrument } (a title
    // such as "Mai Tai 2", or a component name such as "Inst02").
    pluginOf(args) {
        if (args && args.instrument !== undefined) return this.instrumentOf(args.instrument);
        return this.insertPlugin(args);
    }

    // Instruments of the song: Environment/Synths holds Inst01, Inst02... and each
    // has a "Device" child whose title is the instrument's name.
    instrumentList() {
        const synths = docObject("Environment/Synths");
        const out = [];
        if (!synths || typeof synths.find !== "function") return out;
        // Studio One does not renumber InstNN, so deleted instruments leave gaps:
        // scan every number (find on a missing name is cheap).
        for (let i = 1; i <= 99; i++) {
            const cname = "Inst" + (i < 10 ? "0" : "") + i;
            let comp = null;
            try { comp = synths.find(cname); } catch (_) { comp = null; }
            if (!comp) continue;
            let dev = null;
            try { dev = typeof comp.find === "function" ? comp.find("Device") : null; } catch (_) { dev = null; }
            const title = dev && typeof dev.title === "string" && dev.title !== "" ? dev.title : null;
            out.push({ index: i, component: cname, name: title, comp: comp, dev: dev });
        }
        return out;
    }

    instruments() {
        return this.instrumentList().map(x => ({ index: x.index, component: x.component, name: x.name }));
    }

    // Exact component name, then exact title, then case-insensitive title.
    instrumentOf(ref) {
        const want = String(ref);
        const list = this.instrumentList();
        // An explicit component name resolves directly, even case-insensitively ("inst02").
        if (/^Inst\d{2}$/i.test(want)) {
            const cname = "Inst" + want.slice(4);
            const direct = list.filter(x => x.component === cname);
            if (direct.length) return this.instrumentResult(direct[0], want);
        }
        const describe = xs => xs.map(x => x.component + " (" + x.name + ")").join(", ");
        let hit = list.filter(x => x.component === want);
        if (!hit.length) hit = list.filter(x => x.name === want);
        if (!hit.length) hit = list.filter(x => x.name !== null && x.name.toLowerCase() === want.toLowerCase());
        if (!hit.length) return { error: "no instrument named " + want + (list.length ? " (have: " + describe(list) + ")" : " (the song has no instruments)") };
        if (hit.length > 1) return { error: "instrument " + want + " is ambiguous: " + describe(hit) + "; use the component name (e.g. " + hit[0].component + ")" };
        return this.instrumentResult(hit[0], want);
    }

    instrumentResult(x, want) {
        if (!x.dev || typeof x.dev.findParameter !== "function") return { error: "cannot reach the plug-in of instrument " + want };
        return { name: x.name, device: x.dev, component: x.comp, instrument: x.component };
    }

    // { channel, slot } | { instrument } -> { component, device, name } or { error }.
    // The component is the one that takes the Presets commands: an instrument's
    // InstNN, or an insert's FXnn (the device's parent).
    resolveTarget(target) {
        const t = target || {};
        const r = this.pluginOf(t);
        if (r.error) return r;
        const comp = r.component;
        if (!comp || typeof comp.interpretCommand !== "function") return { error: "cannot reach the preset commands of " + r.name };
        return { component: comp, device: r.device, name: r.name };
    }

    presetCommand(args) {
        const command = args.command;
        if (command !== "Export Preset" && command !== "Load Preset File") return { error: "command must be Export Preset or Load Preset File" };
        const t = this.resolveTarget(args.target);
        if (t.error) return t;
        let ok = false;
        try { ok = !!t.component.interpretCommand("Presets", command, true); } catch (_) { ok = false; }
        if (!ok) return { error: command + " is not available for " + t.name };
        // Blocks while the file dialog is open.
        let ran = 0;
        try { ran = t.component.interpretCommand("Presets", command, false); } catch (e) { return { error: command + " failed: " + (e && e.message || e) }; }
        return { ok: !!ran, ran: ran };
    }

    insertPlugin(args) {
        const c = this.channelByLabel(args.channel);
        if (c.error) return c;
        const slot = this.insertsOf(c.el).find(x => x.slot === args.slot);
        if (!slot) return { error: "no plug-in in slot " + args.slot + " on " + args.channel };
        const el = this.subBank(c.el, "inserts").getElement(args.slot);
        const comp = el ? el.component : null;
        const dev = comp && typeof comp.find === "function" ? comp.find("Device") : null;
        if (!dev || typeof dev.findParameter !== "function") return { error: "cannot reach the plug-in in slot " + args.slot + " on " + args.channel };
        return { name: slot.name, device: dev, component: comp };
    }

    // The slot's bank element and its component ("FXnn"). Studio One names the
    // components in creation order, not by position (7.2.3): a plug-in inserted
    // in front of another is FX02 while the older one, now second, stays FX01.
    insertSlot(args) {
        const c = this.channelByLabel(args.channel);
        if (c.error) return c;
        const slot = this.insertsOf(c.el).find(x => x.slot === args.slot);
        if (!slot) return { error: "no plug-in in slot " + args.slot + " on " + args.channel };
        const bank = this.subBank(c.el, "inserts");
        const el = bank ? bank.getElement(args.slot) : null;
        return { name: slot.name, el: el, comp: el ? el.component : null };
    }

    // { channel, slot } -> { name: "FXnn" }, the name the Track Edit slot commands take.
    insertSlotName(args) {
        const s = this.insertSlot(args);
        if (s.error) return s;
        const comp = s.comp;
        const name = comp && typeof comp.name === "string" && comp.name !== "" ? comp.name : null;
        if (!name) return { error: "cannot reach the plug-in in slot " + args.slot + " on " + args.channel };
        return { channel: args.channel, slot: args.slot, plugin: s.name, name: name };
    }

    // Opens the slot's plug-in window and gives it the focus (what a surface's
    // select button does in plug-in mode).
    openPluginEditor(args) {
        if (args.instrument !== undefined) {
            const t = this.resolveTarget(args);
            if (t.error) return t;
            let can = false;
            try { can = !!t.component.interpretCommand("Device", "Edit", true); } catch (_) { can = false; }
            if (!can) return { error: "the editor of " + t.name + " cannot be opened right now" };
            let ran = 0;
            try { ran = t.component.interpretCommand("Device", "Edit", false); } catch (e) { return { error: "opening the editor of " + t.name + " failed: " + (e && e.message || e) }; }
            return { instrument: args.instrument, plugin: t.name, opened: !!ran };
        }
        const s = this.insertSlot(args);
        if (s.error) return s;
        const utils = PreSonus.HostUtils;
        if (!utils || typeof utils.openEditorAndFocus !== "function") return { error: "this Studio One cannot open plug-in editors from a script" };
        if (!s.el || typeof s.el.isConnected !== "function" || !s.el.isConnected()) return { error: "cannot reach the plug-in in slot " + args.slot + " on " + args.channel };
        utils.openEditorAndFocus(this, s.el, "Insert", false);
        return { channel: args.channel, slot: args.slot, plugin: s.name, opened: true };
    }

    paramInfo(p) {
        return {
            name: p.name,
            value: p.value,
            text: typeof p.string === "string" ? p.string : null,
            min: p.min,
            max: p.max,
            normalized: typeof p.getNormalized === "function" ? p.getNormalized() : null,
        };
    }

    targetHead(args) {
        return args.instrument !== undefined ? { instrument: args.instrument } : { channel: args.channel, slot: args.slot };
    }

    pluginParams(args) {
        const plug = this.pluginOf(args);
        if (plug.error) return plug;
        const names = Array.isArray(args.names) ? args.names : [];
        const params = [];
        const missing = [];
        for (const n of names) {
            const p = plug.device.findParameter(String(n));
            if (p) params.push(this.paramInfo(p));
            else missing.push(String(n));
        }
        return Object.assign(this.targetHead(args), { plugin: plug.name, params: params, missing: missing });
    }

    // One of: text (display text, e.g. "4.0:1" or "-12 dB"), normalized (0..1), value (raw).
    setPluginParam(args) {
        const plug = this.pluginOf(args);
        if (plug.error) return plug;
        const p = plug.device.findParameter(String(args.param));
        if (!p) return { error: "no parameter " + args.param + " on " + plug.name + " (live_plugin_params lists them)" };
        const before = this.paramInfo(p);
        if (args.text !== undefined) {
            if (typeof p.fromString !== "function") return { error: "parameter " + args.param + " does not take text" };
            p.fromString(String(args.text), true);
        } else if (args.normalized !== undefined) {
            if (typeof args.normalized !== "number" || args.normalized < 0 || args.normalized > 1) return { error: "normalized must be 0..1" };
            if (typeof p.setNormalized !== "function") return { error: "parameter " + args.param + " has no normalised value" };
            p.setNormalized(args.normalized, true);
        } else if (args.value !== undefined) {
            if (typeof p.setValue !== "function") return { error: "parameter " + args.param + " cannot be set" };
            p.setValue(args.value, true);
        } else {
            return { error: "give one of text, normalized or value" };
        }
        return Object.assign(this.targetHead(args), { plugin: plug.name, param: String(args.param), before: before, after: this.paramInfo(p) });
    }

    setChannel(args) {
        const fields = { volume: PreSonus.ParamID.kVolume, pan: PreSonus.ParamID.kPan, mute: "mute", solo: "solo", recordArmed: PreSonus.ParamID.kRecord, monitor: "monitor" };
        const param = fields[args.field];
        if (!param) return { error: "field must be one of " + Object.keys(fields).join(", ") };
        const els = this.channelElements();
        if (els.error) return els;
        const matches = els.filter(c => c.label === args.channel);
        if (matches.length !== 1) return { error: matches.length ? "channel name is ambiguous: " + args.channel : "no channel named " + args.channel };
        const el = matches[0].el;
        const before = this.readParam(el, param);
        el.setParamValue(param, args.value);
        const out = { channel: args.channel, field: args.field, before: before, after: this.readParam(el, param) };
        // Volume and pan also as Studio One shows them ("-6.0 dB", "L25"): the
        // normalised fader curve is not documented, so dB are found by reading this.
        if (args.field === "volume" || args.field === "pan") out.text = this.displayOf(el, param);
        return out;
    }
}

function createBridgeComponent() {
    return new BridgeComponent();
}
