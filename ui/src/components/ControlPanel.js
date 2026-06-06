// ControlPanel —— liteWearable 设备状态/传感器控件，每个绑定一条 set 命令。
// 字段名/范围见 ../../docs/protocol.md §3.5（设备能力）。

// 声明式控件表：{label, command, kind, ...} → 生成 UI 并在变更时下发 set 命令。
const CONTROLS = [
  { label: "心率 HeartRate", command: "HeartRate", kind: "range", min: 0, max: 255, value: 80, arg: (v) => ({ HeartRate: +v }) },
  { label: "步数 StepCount", command: "StepCount", kind: "number", min: 0, max: 999999, value: 0, arg: (v) => ({ StepCount: +v }) },
  { label: "气压 Barometer", command: "Barometer", kind: "number", min: 0, max: 999900, value: 101325, arg: (v) => ({ Barometer: +v }) },
  { label: "电量 Power", command: "Power", kind: "range", min: 0, max: 100, value: 100, arg: (v) => ({ Power: +v / 100 }), fmt: (v) => `${v}%` },
  { label: "充电 ChargeMode", command: "ChargeMode", kind: "toggle", value: 0, arg: (v) => ({ ChargeMode: v ? 1 : 0 }) },
  { label: "亮度 Brightness", command: "Brightness", kind: "range", min: 1, max: 255, value: 170, arg: (v) => ({ Brightness: +v }) },
  { label: "自动亮度 BrightnessMode", command: "BrightnessMode", kind: "toggle", value: 0, arg: (v) => ({ BrightnessMode: v ? 1 : 0 }) },
  { label: "佩戴 WearingState", command: "WearingState", kind: "toggle", value: 1, arg: (v) => ({ WearingState: !!v }) },
  { label: "常亮 KeepScreenOnState", command: "KeepScreenOnState", kind: "toggle", value: 1, arg: (v) => ({ KeepScreenOnState: !!v }) },
  { label: "语言 Language", command: "Language", kind: "select", options: ["zh-CN", "en-US"], value: "zh-CN", arg: (v) => ({ Language: v }) },
];

export class ControlPanel {
  /**
   * @param {HTMLElement} root
   * @param {{send:(m:object)=>void}} transport
   */
  constructor(root, transport) {
    this.transport = transport;
    const section = document.createElement("div");
    section.className = "panel-section";
    section.innerHTML = `<h3>设备状态</h3>`;
    root.appendChild(section);

    for (const c of CONTROLS) section.appendChild(this._control(c));
    section.appendChild(this._location());
  }

  _set(command, args) {
    this.transport.send({ type: "command", command, cmdType: "set", args });
  }

  _control(c) {
    const row = document.createElement("label");
    row.className = "ctl";
    const name = document.createElement("span");
    name.className = "ctl-name";
    name.textContent = c.label;
    const valLabel = document.createElement("span");
    valLabel.className = "ctl-val";

    let input;
    if (c.kind === "range" || c.kind === "number") {
      input = document.createElement("input");
      input.type = c.kind;
      input.min = c.min; input.max = c.max; input.value = c.value;
      const update = () => {
        valLabel.textContent = c.fmt ? c.fmt(input.value) : input.value;
        this._set(c.command, c.arg(input.value));
      };
      input.addEventListener("input", () => (valLabel.textContent = c.fmt ? c.fmt(input.value) : input.value));
      input.addEventListener("change", update);
      valLabel.textContent = c.fmt ? c.fmt(c.value) : c.value;
    } else if (c.kind === "toggle") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!c.value;
      input.addEventListener("change", () => this._set(c.command, c.arg(input.checked)));
    } else if (c.kind === "select") {
      input = document.createElement("select");
      for (const o of c.options) {
        const opt = document.createElement("option");
        opt.value = o; opt.textContent = o; input.appendChild(opt);
      }
      input.value = c.value;
      input.addEventListener("change", () => this._set(c.command, c.arg(input.value)));
    }
    input.className = "ctl-input";
    row.append(name, input, valLabel);
    return row;
  }

  // Location 特殊：后端要求 latitude/longitude 为 string 且含小数点
  _location() {
    const row = document.createElement("div");
    row.className = "ctl ctl--loc";
    row.innerHTML = `<span class="ctl-name">定位 Location</span>`;
    const lat = Object.assign(document.createElement("input"), { type: "number", value: "39.9", step: "0.0001", className: "ctl-input" });
    const lon = Object.assign(document.createElement("input"), { type: "number", value: "116.4", step: "0.0001", className: "ctl-input" });
    const send = () => {
      const s = (n) => (String(n).includes(".") ? String(n) : String(n) + ".0");
      this._set("Location", { latitude: s(lat.value), longitude: s(lon.value) });
    };
    lat.addEventListener("change", send);
    lon.addEventListener("change", send);
    row.append(lat, lon);
    return row;
  }
}
