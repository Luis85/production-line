import { nextTick } from 'vue';

/** Fail the story if its intended state never becomes available. */
export async function findElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const element = root.querySelector<T>(selector);
    if (element) return element;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Story element did not appear: ${selector}`);
}

export async function clickButton(root: ParentNode, text: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent?.trim() === text && !item.disabled);
    if (button) { button.click(); await nextTick(); return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Story button did not appear: ${text}`);
}

export async function fillInput(root: ParentNode, selector: string, value: string): Promise<void> {
  const input = await findElement<HTMLInputElement | HTMLTextAreaElement>(root, selector);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
}
