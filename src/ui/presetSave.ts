/** Save controls for a section's bottom action row: the name field and check button replace the start button inline. */
export function presetSaveInlineMarkup(id: string): string {
  return `
    <button id="${id}-save-start" type="button">Save as preset</button>
    <form id="${id}-save-form" class="preset-save-inline" hidden>
      <input id="${id}-name" type="text" maxlength="60" required aria-label="Preset name" placeholder="Preset name" />
      <button type="submit" aria-label="Save preset" title="Save preset">&#10003;</button>
    </form>`;
}

export const presetSaveNoteMarkup = (id: string): string => `<p id="${id}-save-note" class="small" role="status"></p>`;

export function initPresetSave(root: ParentNode, id: string, save: (name: string) => Promise<void>): void {
  const form = root.querySelector<HTMLFormElement>(`#${id}-save-form`)!;
  const name = root.querySelector<HTMLInputElement>(`#${id}-name`)!;
  const start = root.querySelector<HTMLButtonElement>(`#${id}-save-start`)!;
  const confirm = form.querySelector<HTMLButtonElement>('button')!;
  const note = root.querySelector<HTMLElement>(`#${id}-save-note`)!;
  start.onclick = () => { form.hidden = false; start.hidden = true; note.textContent = ''; name.focus(); };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!name.value.trim()) { note.textContent = 'Enter a preset name.'; name.focus(); return; }
    confirm.disabled = true;
    const value = name.value.trim();
    try {
      await save(value);
      note.textContent = `Saved "${value}".`;
      name.value = '';
      form.hidden = true;
      start.hidden = false;
      start.focus();
    } catch (e) { note.textContent = `Could not save preset: ${(e as Error).message}`; }
    finally { confirm.disabled = false; }
  };
}
