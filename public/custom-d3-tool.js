export default class CustomBarChartAdapter {
  mount(container, data) {
    this.container = container;
    this.container.innerHTML = `<div id="barchart" style="padding: 20px; font-size: 24px; color: #333; background: #e8f5e9; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;"><h1>Dynamic Native JS Module</h1><pre id="state-output"></pre></div>`;
  }
  unmount() {
    if (this.container) this.container.innerHTML = "";
  }
  setState(state, time) {
    const el = this.container.querySelector("#state-output");
    if (el) el.textContent = "Time: " + Math.round(time) + "\nState: " + JSON.stringify(state, null, 2);
  }
}