const PLACEHOLDER =
	/^WICEK_LOGIN_[a-z0-9]+_(?:USERNAME@wicek\.invalid|PASSWORD)$/i;
const pendingFields = new WeakSet();

window.addEventListener('input', fillPlaceholder, true);
window.addEventListener('change', fillPlaceholder, true);

async function fillPlaceholder(event) {
	const field = event.target;
	if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement))
		return;
	const placeholder = field.value.trim();
	if (!PLACEHOLDER.test(placeholder) || pendingFields.has(field)) return;

	pendingFields.add(field);
	try {
		const value = await chrome.runtime.sendMessage({ type: 'fill', placeholder });
		if (value !== null && field.value.trim() === placeholder) {
			setValue(field, value);
		}
	} finally {
		pendingFields.delete(field);
	}
}

function setValue(field, value) {
	const prototype = Object.getPrototypeOf(field);
	Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, value);
	field.dispatchEvent(new Event('input', { bubbles: true }));
	field.dispatchEvent(new Event('change', { bubbles: true }));
}
