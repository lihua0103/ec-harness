/** Local directory picker: asks the workbench host to open its native folder dialog. */
import { PlatformApi } from './api.mjs';

const api = new PlatformApi();

document.addEventListener('click', async (event) => {
  const trigger = event.target.closest('[data-pick-dir]');
  if (!trigger) return;
  const form = trigger.closest('form');
  if (!form) return;
  const target = trigger.dataset.target ? form.querySelector(trigger.dataset.target) : null;
  const display = trigger.dataset.display
    ? form.querySelector(`[data-dir-display="${trigger.dataset.display}"]`)
    : null;
  if (!target) return;
  const previous = display?.textContent ?? '';
  trigger.disabled = true;
  if (display) display.textContent = '正在等待本机选择目录…';
  try {
    const result = await api.pickDirectory();
    if (result?.path) {
      target.value = result.path;
      if (display) display.textContent = result.path;
    } else if (display) {
      display.textContent = previous || '尚未选择';
    }
  } catch (error) {
    if (display) display.textContent = previous || '尚未选择';
    // A failed dialog must not block the form; the operator sees the reason and can retry.
    window.alert?.(error instanceof Error ? error.message : '无法打开目录选择。');
  } finally {
    trigger.disabled = false;
  }
});
