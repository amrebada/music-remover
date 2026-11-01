/** Small label over a video for states the user may need to act on. */
export class StatusChip {
  private host?: HTMLElement;
  private label?: HTMLElement;

  show(element: HTMLElement, text: string, onClick?: () => void) {
    if (!this.host) {
      this.host = document.createElement('music-remover-chip');
      const root = this.host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>
        div { position: fixed; z-index: 2147483647; padding: 6px 10px; border-radius: 6px;
          background: rgba(17, 24, 39, 0.88); color: #fff; font: 500 12px/1.3 system-ui, sans-serif;
          cursor: default; pointer-events: auto; max-width: 260px; }
        div.action { cursor: pointer; background: #15803d; }
      </style><div></div>`;
      this.label = root.querySelector('div')!;
      document.documentElement.append(this.host);
    }
    const rect = element.getBoundingClientRect();
    if (rect.width < 120 || rect.bottom < 0 || rect.top > innerHeight) return this.hide();
    const label = this.label!;
    label.textContent = text;
    label.className = onClick ? 'action' : '';
    label.onclick = onClick ?? null;
    label.style.left = `${Math.max(8, rect.left + 12)}px`;
    label.style.top = `${Math.max(8, rect.top + 12)}px`;
    this.host.hidden = false;
  }

  hide() {
    if (this.host) this.host.hidden = true;
  }
}
