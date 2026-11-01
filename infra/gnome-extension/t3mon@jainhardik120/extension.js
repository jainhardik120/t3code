// T3 Monitor: panel indicator for a local T3 Code server.
// Polls GET /api/orchestration/activity (running threads, their background work and
// the CPU/memory of each thread's process tree). Requests are async Soup calls, so a
// slow or stopped server never blocks the shell. Visual language follows Astra
// Monitor and Battmon: mini graph in the panel, pill tooltip, centred-section menu.
import Cairo from "cairo";
import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Pango from "gi://Pango";
import Soup from "gi://Soup?version=3.0";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

Gio._promisify(Soup.Session.prototype, "send_and_read_async");
Gio._promisify(Gio.File.prototype, "load_contents_async");

const CONFIG_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), "t3mon", "config.json"]);
const DEFAULT_CONFIG = { serverUrl: "http://127.0.0.1:3773", token: "", webUrl: "" };
const REFRESH_S = 3;
const HISTORY_POINTS = 300; // 15 min at 3 s
const MINI_POINTS = 50;
const MAX_PROCESSES = 12; // per expanded thread

// Astra Monitor palette
const BLUE = [29 / 255, 172 / 255, 214 / 255];
const AMBER = [245 / 255, 166 / 255, 35 / 255];
const GREY = [0.6, 0.6, 0.6];

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function fmtCpu(pct) {
  return `${pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%`;
}

function fmtElapsed(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Agent shells wrap each command in a snapshot loader; show the command itself.
function displayCommand(proc) {
  const cmd = proc.command || proc.name;
  const evaled = cmd.match(/\beval '((?:[^']|'\\'')*)'/);
  if (evaled) return `$ ${evaled[1].replace(/'\\''/g, "'")}`;
  const model = cmd.match(/--model\s+(\S+)/);
  if (/(^|\/)claude(\s|$)/.test(cmd))
    return `claude${model ? ` · ${model[1].replace(/^claude-/, "")}` : ""}`;
  const npx = cmd.match(/npm exec (\S+)/);
  if (npx) return `mcp: ${npx[1].replace(/@[^@/]*$/, "")}`;
  const [bin, ...rest] = cmd.split(/\s+/);
  return [bin.split("/").pop(), ...rest].join(" ");
}

function threadState(thread) {
  if (thread.waitingOnUser) return "waiting";
  if (thread.runStatus !== null) return "running";
  if (thread.status === "failed" || thread.status === "interrupted") return "failed";
  return "idle";
}

const STATE_LABEL = {
  waiting: "waiting on you",
  running: "running",
  failed: "stopped",
  idle: "background",
};

const TASK_LABEL = {
  command: "command",
  monitor: "monitor",
  subagent: "subagent",
  background_task: "task",
};

function roundedClip(cr, w, h, r) {
  cr.newSubPath();
  cr.arc(w - r, r, r, -Math.PI / 2, 0);
  cr.arc(w - r, h - r, r, 0, Math.PI / 2);
  cr.arc(r, h - r, r, Math.PI / 2, Math.PI);
  cr.arc(r, r, r, Math.PI, 1.5 * Math.PI);
  cr.closePath();
  cr.clip();
}

// Panel mini graph: T3's share of machine CPU, one bar per sample. Bars turn amber
// while an agent is waiting on the user.
const MiniGraph = GObject.registerClass(
  class MiniGraph extends St.DrawingArea {
    _init() {
      super._init({ style_class: "t3mon-graph-mini", y_align: Clutter.ActorAlign.CENTER });
      this.samples = [];
    }

    vfunc_repaint() {
      const cr = this.get_context();
      const [w, h] = this.get_surface_size();
      try {
        roundedClip(cr, w, h, 3);
        cr.setSourceRGBA(0, 0, 0, 0.2);
        cr.rectangle(0, 0, w, h);
        cr.fill();
        const points = this.samples.slice(-MINI_POINTS);
        const bw = w / MINI_POINTS;
        const offset = MINI_POINTS - points.length;
        points.forEach((s, i) => {
          const [r, g, b] = s.waiting ? AMBER : BLUE;
          cr.setSourceRGBA(r, g, b, 1);
          const bh = Math.max(s.running ? 1 : 0, Math.min(1, s.cpu / 100) * h);
          cr.rectangle(Math.floor((offset + i) * bw), h - bh, Math.ceil(bw), bh);
          cr.fill();
        });
        cr.setSourceRGBA(1, 1, 1, 0.2);
        cr.setLineWidth(0.5);
        cr.moveTo(0, h * 0.5);
        cr.lineTo(w, h * 0.5);
        cr.stroke();
      } finally {
        cr.$dispose();
      }
    }
  },
);

// Menu graph: T3 CPU (% of machine) as bars, memory as a line, running agents as a
// faint step band along the bottom.
const HistoryGraph = GObject.registerClass(
  class HistoryGraph extends St.DrawingArea {
    _init() {
      super._init({ style_class: "t3mon-graph", x_expand: true });
      this.samples = [];
      this.maxCpu = 10;
      this.maxMem = 1;
    }

    vfunc_repaint() {
      const cr = this.get_context();
      const [w, h] = this.get_surface_size();
      try {
        this._draw(cr, w, h);
      } finally {
        cr.$dispose();
      }
    }

    _draw(cr, w, h) {
      cr.setSourceRGBA(0, 0, 0, 0.2);
      cr.rectangle(0, 0, w, h);
      cr.fill();
      const samples = this.samples;
      if (!samples.length) return;
      this.maxCpu = Math.max(10, ...samples.map((s) => s.cpu));
      this.maxMem = Math.max(1, ...samples.map((s) => s.mem));
      const bw = w / HISTORY_POINTS;
      const offset = HISTORY_POINTS - samples.length;

      cr.setSourceRGBA(1, 1, 1, 0.08);
      for (const p of [0.25, 0.5, 0.75]) {
        cr.rectangle(0, Math.round(h * p), w, 1);
        cr.fill();
      }

      samples.forEach((s, i) => {
        const [r, g, b] = s.waiting ? AMBER : BLUE;
        cr.setSourceRGBA(r, g, b, 0.9);
        const bh = (s.cpu / this.maxCpu) * (h - 2);
        cr.rectangle((offset + i) * bw, h - bh, Math.max(1, bw - 0.3), bh);
        cr.fill();
      });

      cr.setSourceRGBA(...GREY, 0.9);
      cr.setLineWidth(1.25);
      samples.forEach((s, i) => {
        const x = (offset + i + 0.5) * bw;
        const y = h - 1 - (s.mem / this.maxMem) * (h - 4);
        if (i === 0) cr.moveTo(x, y);
        else cr.lineTo(x, y);
      });
      cr.stroke();
    }
  },
);

const Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {
    _init(ext) {
      super._init(0.5, "T3 Monitor");
      this._ext = ext;
      this._session = new Soup.Session({ timeout: 5 });
      this._cancellable = new Gio.Cancellable();
      this._config = { ...DEFAULT_CONFIG };
      this._history = [];
      this._expanded = new Set();
      this._snapshot = null;
      this._error = null;
      this._environmentId = null;
      this.add_style_class_name("t3mon-header");

      const box = new St.BoxLayout({
        style_class: "t3mon-header-box",
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._icon = new St.Icon({
        gicon: Gio.icon_new_for_string(`${ext.path}/icons/t3mon-symbolic.svg`),
        style_class: "t3mon-header-icon",
        y_align: Clutter.ActorAlign.CENTER,
      });
      box.add_child(this._icon);
      this._count = new St.Label({
        text: "–",
        style_class: "t3mon-header-count",
        y_align: Clutter.ActorAlign.CENTER,
      });
      box.add_child(this._count);
      this._mini = new MiniGraph();
      box.add_child(this._mini);
      this.add_child(box);

      this._buildTooltip();
      this._buildMenu();
      this.menu.connect("open-state-changed", (_m, open) => {
        if (open) {
          this._tooltip.close(false);
          this._renderMenu();
        }
      });

      this._loadConfig()
        .then(() => this._refresh())
        .catch(logError);
      this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, REFRESH_S, () => {
        this._refresh();
        return GLib.SOURCE_CONTINUE;
      });
    }

    async _loadConfig() {
      try {
        const [bytes] = await Gio.File.new_for_path(CONFIG_PATH).load_contents_async(
          this._cancellable,
        );
        this._config = { ...DEFAULT_CONFIG, ...JSON.parse(new TextDecoder().decode(bytes)) };
      } catch (e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
          logError(e, "t3mon: reading config");
        this._config = { ...DEFAULT_CONFIG };
      }
      this._config.serverUrl = this._config.serverUrl.replace(/\/+$/, "");
      this._config.webUrl = (this._config.webUrl || this._config.serverUrl).replace(/\/+$/, "");
    }

    async _get(path) {
      const msg = Soup.Message.new("GET", `${this._config.serverUrl}${path}`);
      if (this._config.token)
        msg.request_headers.append("Authorization", `Bearer ${this._config.token}`);
      const bytes = await this._session.send_and_read_async(
        msg,
        GLib.PRIORITY_LOW,
        this._cancellable,
      );
      const status = msg.get_status();
      const text = new TextDecoder().decode(bytes.toArray());
      if (status !== Soup.Status.OK) {
        let reason = `HTTP ${status}`;
        try {
          reason = JSON.parse(text).reason ?? reason;
        } catch {}
        throw new Error(reason);
      }
      return JSON.parse(text);
    }

    async _refresh() {
      if (this._inflight) return;
      this._inflight = true;
      try {
        if (!this._config.token) throw new Error("no token configured");
        if (this._environmentId === null) {
          const env = await this._get("/.well-known/t3/environment").catch(() => null);
          this._environmentId = env?.environmentId ?? null;
        }
        this._snapshot = await this._get("/api/orchestration/activity");
        this._error = null;
        const s = this._snapshot;
        const cores = Math.max(1, s.host?.cpuCount ?? 1);
        this._history.push({
          cpu: s.total.cpuPercent / cores,
          mem: s.total.residentBytes,
          running: s.threads.filter((t) => t.runStatus !== null).length,
          waiting: s.threads.some((t) => t.waitingOnUser),
        });
        if (this._history.length > HISTORY_POINTS)
          this._history.splice(0, this._history.length - HISTORY_POINTS);
      } catch (e) {
        if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
        this._error = e.message;
        this._snapshot = null;
      } finally {
        this._inflight = false;
      }
      this._renderHeader();
      if (this.menu.isOpen) this._renderMenu();
    }

    _renderHeader() {
      const s = this._snapshot;
      this._mini.samples = this._history;
      this._mini.queue_repaint();
      this._icon.remove_style_class_name("t3mon-header-icon-offline");
      this._icon.remove_style_class_name("t3mon-header-icon-waiting");
      if (!s) {
        this._icon.add_style_class_name("t3mon-header-icon-offline");
        this._count.text = "–";
        this._count.add_style_class_name("t3mon-header-count-idle");
        this._setTooltip(`T3: ${this._error ?? "connecting…"}`);
        return;
      }
      const running = s.threads.filter((t) => t.runStatus !== null);
      const waiting = s.threads.filter((t) => t.waitingOnUser);
      if (waiting.length) this._icon.add_style_class_name("t3mon-header-icon-waiting");
      this._count.text = String(running.length);
      if (running.length) this._count.remove_style_class_name("t3mon-header-count-idle");
      else this._count.add_style_class_name("t3mon-header-count-idle");
      const cores = Math.max(1, s.host?.cpuCount ?? 1);
      const tip = [running.length ? `${running.length} running` : "no agents running"];
      if (waiting.length) tip.push(`${waiting.length} waiting on you`);
      tip.push(`${fmtCpu(s.total.cpuPercent / cores)} CPU`, fmtBytes(s.total.residentBytes));
      this._setTooltip(tip.join(" | "));
    }

    // Hover pill, same construction as Astra's header tooltips.
    _buildTooltip() {
      this._tooltip = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP);
      Main.uiGroup.add_child(this._tooltip.actor);
      this._tooltip.actor.hide();
      this._tooltipItem = new PopupMenu.PopupMenuItem("", {
        reactive: true,
        style_class: "t3mon-tooltip-item",
      });
      this._tooltipItem.actor.x_expand = true;
      this._tooltipItem.actor.x_align = Clutter.ActorAlign.CENTER;
      this._tooltip.addMenuItem(this._tooltipItem);
      this.connect("enter-event", () => {
        if (!this.menu.isOpen && this._tooltipItem.label.text) this._tooltip.open(false);
      });
      this.connect("leave-event", () => this._tooltip.close(false));
    }

    _setTooltip(text) {
      this._tooltipItem.label.text = text;
      this._tooltip.actor.set_width(this._tooltipItem.get_preferred_width(-1)[1] + 30);
    }

    _buildMenu() {
      const section = new PopupMenu.PopupMenuSection();
      this.menu.addMenuItem(section);
      this.menu.actor.add_style_class_name("t3mon-menu");
      const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: "t3mon-menu-box",
        x_expand: true,
      });
      section.box.add_child(box);

      this._agentsHeader = new St.Label({
        text: "Agents",
        style_class: "t3mon-menu-header-centered",
        x_expand: true,
      });
      box.add_child(this._agentsHeader);
      this._threadBox = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
      });
      box.add_child(this._threadBox);

      box.add_child(
        new St.Label({
          text: "Resources",
          style_class: "t3mon-menu-header-centered",
          x_expand: true,
        }),
      );
      const graphGrid = new St.Widget({ layout_manager: new Clutter.GridLayout(), x_expand: true });
      const gl = graphGrid.layout_manager;
      this._graph = new HistoryGraph();
      gl.attach(this._graph, 0, 0, 2, 3);
      const axis = (text, yAlign) =>
        new St.Label({ text, style_class: "t3mon-graph-label", y_align: yAlign });
      this._axisCpu = axis("", Clutter.ActorAlign.START);
      gl.attach(this._axisCpu, 2, 0, 1, 1);
      this._axisMem = axis("", Clutter.ActorAlign.CENTER);
      gl.attach(this._axisMem, 2, 1, 1, 1);
      gl.attach(axis("", Clutter.ActorAlign.END), 2, 2, 1, 1);
      gl.attach(
        new St.Label({ text: "15 min ago", style_class: "t3mon-graph-label-then", x_expand: true }),
        0,
        3,
        1,
        1,
      );
      gl.attach(
        new St.Label({ text: "now", style_class: "t3mon-graph-label-now", x_expand: true }),
        1,
        3,
        1,
        1,
      );
      box.add_child(graphGrid);
      box.add_child(
        new St.Label({
          style_class: "t3mon-legend",
          x_expand: true,
          text: "bars: T3 CPU (% of machine)  ·  line: T3 memory  ·  amber: waiting on you",
        }),
      );

      const grid = new St.Widget({
        layout_manager: new Clutter.GridLayout({ orientation: Clutter.Orientation.VERTICAL }),
        style_class: "t3mon-grid",
        x_expand: true,
      });
      let row = 0;
      const stat = (key) => {
        const k = new St.Label({ text: key, style_class: "t3mon-menu-label", x_expand: true });
        const v = new St.Label({ text: "-", style_class: "t3mon-menu-key", x_expand: true });
        grid.layout_manager.attach(k, 0, row, 1, 1);
        grid.layout_manager.attach(v, 1, row++, 1, 1);
        return v;
      };
      this._v = {
        t3: stat("T3 total"),
        agents: stat("Agent processes"),
        shared: stat("Server & shared"),
        host: stat("Machine"),
      };
      box.add_child(grid);

      const buttons = new St.BoxLayout({
        style_class: "t3mon-menu-button-box",
        x_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
      });
      const button = (icon, onClick) => {
        const b = new St.Button({
          style_class: "button",
          can_focus: true,
          child: new St.Icon({ icon_name: icon }),
        });
        b.connect("clicked", onClick);
        buttons.add_child(b);
      };
      button("web-browser-symbolic", () => {
        this.menu.close();
        Gio.AppInfo.launch_default_for_uri(this._config.webUrl, null);
      });
      button("view-refresh-symbolic", () => {
        this._loadConfig()
          .then(() => this._refresh())
          .catch(logError);
      });
      button("document-edit-symbolic", () => {
        this.menu.close();
        Gio.AppInfo.launch_default_for_uri(`file://${CONFIG_PATH}`, null);
      });
      box.add_child(buttons);
    }

    _renderMenu() {
      this._threadBox.destroy_all_children();
      const s = this._snapshot;
      if (!s) {
        const hint = this._config.token
          ? `Can't reach T3 at ${this._config.serverUrl}: ${this._error ?? "connecting…"}`
          : `Add a token to ${CONFIG_PATH}\n(t3 auth session issue --label gnome --token-only)`;
        this._threadBox.add_child(
          new St.Label({ text: hint, style_class: "t3mon-menu-warning", x_expand: true }),
        );
        return;
      }
      const running = s.threads.filter((t) => t.runStatus !== null).length;
      this._agentsHeader.text = running ? `Agents · ${running} running` : "Agents";
      if (!s.threads.length) {
        this._threadBox.add_child(
          new St.Label({
            text: "No agents running",
            style_class: "t3mon-menu-empty",
            x_expand: true,
          }),
        );
      }
      for (const thread of s.threads) this._threadBox.add_child(this._threadRow(thread));

      const cores = Math.max(1, s.host?.cpuCount ?? 1);
      const agentUsage = s.threads.reduce(
        (a, t) => ({
          cpu: a.cpu + t.usage.cpuPercent,
          mem: a.mem + t.usage.residentBytes,
          n: a.n + t.usage.processCount,
        }),
        { cpu: 0, mem: 0, n: 0 },
      );
      const shared = {
        cpu: s.total.cpuPercent - agentUsage.cpu,
        mem: s.total.residentBytes - agentUsage.mem,
        n: s.total.processCount - agentUsage.n,
      };
      this._v.t3.text =
        `${fmtCpu(s.total.cpuPercent / cores)}  ·  ${fmtBytes(s.total.residentBytes)}  ·  ` +
        `${s.total.processCount} procs`;
      this._v.agents.text = `${fmtCpu(agentUsage.cpu / cores)}  ·  ${fmtBytes(agentUsage.mem)}  ·  ${agentUsage.n} procs`;
      this._v.shared.text =
        `${fmtCpu(Math.max(0, shared.cpu) / cores)}  ·  ${fmtBytes(Math.max(0, shared.mem))}  ·  ` +
        `${Math.max(0, shared.n)} procs`;
      const hostCpu = s.host?.cpuUtilization;
      const used = (s.host?.totalMemoryBytes ?? 0) - (s.host?.availableMemoryBytes ?? 0);
      this._v.host.text =
        `${hostCpu == null ? "-" : fmtCpu(hostCpu * 100)} CPU  ·  ` +
        `${fmtBytes(used)} / ${fmtBytes(s.host?.totalMemoryBytes ?? 0)}`;

      this._graph.samples = this._history;
      this._graph.queue_repaint();
      GLib.idle_add(GLib.PRIORITY_LOW, () => {
        this._axisCpu.text = fmtCpu(this._graph.maxCpu);
        this._axisMem.text = fmtBytes(this._graph.maxMem);
        return GLib.SOURCE_REMOVE;
      });
    }

    _threadRow(thread) {
      const state = threadState(thread);
      const expanded = this._expanded.has(thread.threadId);
      const body = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, x_expand: true });
      const button = new St.Button({
        style_class: `t3mon-thread${expanded ? " t3mon-thread-expanded" : ""}`,
        child: body,
        x_expand: true,
        can_focus: true,
        reactive: true,
      });
      button.connect("clicked", () => {
        if (this._expanded.has(thread.threadId)) this._expanded.delete(thread.threadId);
        else this._expanded.add(thread.threadId);
        this._renderMenu();
      });

      const head = new St.BoxLayout({ style_class: "t3mon-thread-head", x_expand: true });
      head.add_child(
        new St.Label({
          text: "●",
          style_class: `t3mon-dot t3mon-dot-${state}`,
          y_align: Clutter.ActorAlign.START,
        }),
      );
      const title = new St.Label({
        text: thread.title || "Untitled thread",
        style_class: "t3mon-thread-title",
        x_expand: true,
      });
      title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      head.add_child(title);
      head.add_child(
        new St.Label({
          style_class: "t3mon-thread-usage",
          text: thread.usage.processCount
            ? `${fmtCpu(thread.usage.cpuPercent)}  ${fmtBytes(thread.usage.residentBytes)}`
            : "",
        }),
      );
      body.add_child(head);

      const meta = [thread.projectTitle, thread.model, STATE_LABEL[state]];
      if (thread.runStatus !== null && thread.runStartedAt)
        meta[2] = `${STATE_LABEL[state]} ${fmtElapsed(thread.runStartedAt)}`;
      if (thread.usage.processCount)
        meta.push(`${thread.usage.processCount} proc${thread.usage.processCount === 1 ? "" : "s"}`);
      if (thread.backgroundTasks.length) meta.push(`${thread.backgroundTasks.length} background`);
      const metaRow = new St.BoxLayout({ x_expand: true });
      const metaLabel = new St.Label({
        text: meta.filter(Boolean).join("  ·  "),
        style_class: "t3mon-thread-meta",
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      });
      metaLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
      metaRow.add_child(metaLabel);
      if (this._environmentId) {
        const open = new St.Button({ label: "Open", style_class: "t3mon-open", can_focus: true });
        open.connect("clicked", () => {
          this.menu.close();
          Gio.AppInfo.launch_default_for_uri(
            `${this._config.webUrl}/${this._environmentId}/${encodeURIComponent(thread.threadId)}`,
            null,
          );
        });
        metaRow.add_child(open);
      }
      body.add_child(metaRow);

      if (expanded) body.add_child(this._threadDetail(thread));
      return button;
    }

    _threadDetail(thread) {
      const detail = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: "t3mon-detail",
        x_expand: true,
      });
      if (thread.processes.length) {
        detail.add_child(new St.Label({ text: "PROCESSES", style_class: "t3mon-detail-header" }));
        const procs = thread.processes
          .toSorted((a, b) => b.cpuPercent - a.cpuPercent || a.depth - b.depth)
          .slice(0, MAX_PROCESSES)
          .toSorted((a, b) => thread.processes.indexOf(a) - thread.processes.indexOf(b));
        for (const p of procs) {
          const row = new St.BoxLayout({ style_class: "t3mon-proc", x_expand: true });
          const indent = "  ".repeat(Math.min(p.depth, 6));
          const name = new St.Label({
            text: `${indent}${p.depth ? "└ " : ""}${displayCommand(p)}`,
            style_class: "t3mon-proc-name",
            x_expand: true,
          });
          name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
          row.add_child(name);
          row.add_child(
            new St.Label({
              text: `${fmtCpu(p.cpuPercent).padStart(5)} ${fmtBytes(p.residentBytes).padStart(7)}`,
              style_class: "t3mon-proc-usage",
            }),
          );
          detail.add_child(row);
        }
        if (thread.processes.length > procs.length) {
          detail.add_child(
            new St.Label({
              text: `+ ${thread.processes.length - procs.length} more`,
              style_class: "t3mon-task",
            }),
          );
        }
      }
      if (thread.backgroundTasks.length) {
        detail.add_child(new St.Label({ text: "BACKGROUND", style_class: "t3mon-detail-header" }));
        for (const task of thread.backgroundTasks) {
          const label = new St.Label({
            text: `${TASK_LABEL[task.kind] ?? task.kind}: ${task.description ?? task.taskId}`,
            style_class: "t3mon-task",
            x_expand: true,
          });
          label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
          detail.add_child(label);
        }
      }
      if (!thread.processes.length && !thread.backgroundTasks.length)
        detail.add_child(
          new St.Label({
            text: "No processes attributed to this thread.",
            style_class: "t3mon-task",
          }),
        );
      return detail;
    }

    destroy() {
      if (this._timer) {
        GLib.source_remove(this._timer);
        this._timer = null;
      }
      this._cancellable.cancel();
      this._session.abort();
      this._tooltip?.destroy();
      this._tooltip = null;
      super.destroy();
    }
  },
);

export default class T3MonitorExtension extends Extension {
  enable() {
    this._indicator = new Indicator(this);
    // Left side, after the workspace indicator: the right side is full on this laptop.
    Main.panel.addToStatusArea(this.uuid, this._indicator, 1, "left");
  }

  disable() {
    this._indicator?.destroy();
    this._indicator = null;
  }
}
