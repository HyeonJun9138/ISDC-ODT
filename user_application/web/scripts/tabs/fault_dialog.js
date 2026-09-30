// Fault injection dialog and labels shared by the settings and status tabs. The dialog targets the
// communication model's nodes and links; injected faults are SIM faults, not measured failures.
import { store } from "../state.js";

const FAULT_LABELS = { link_loss: "링크 손실", latency_spike: "지연 증가", power_drop: "전력 저하", thermal_spike: "열 상승", storage_pressure: "저장소 포화" };

export function escapeMarkup(value) {
  return String(value ?? "—").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

export function faultLabel(kind) {
  return FAULT_LABELS[kind] || kind || "—";
}

export function openFaultDialog(preferredTarget = null) {
  const target = document.querySelector("#fault-target");
  if (target) {
    const nodes = (store.communication?.nodes || []).map(node => node.id);
    const links = (store.communication?.links || []).map(link => link.id);
    const ids = [...(preferredTarget ? [preferredTarget] : []), ...nodes.filter(id => id !== preferredTarget), ...links];
    target.innerHTML = ids.map(id => `<option>${escapeMarkup(id)}</option>`).join("");
  }
  document.querySelector("#fault-dialog")?.showModal();
}
