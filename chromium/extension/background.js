const FILL_URL = 'http://logins.broker/fill';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message?.type !== 'fill' || !sender.url) return false;
	requestValue(message.placeholder, sender.url).then(sendResponse);
	return true;
});

async function requestValue(placeholder, pageUrl) {
	try {
		const response = await fetch(FILL_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ placeholder, url: pageUrl }),
		});
		if (!response.ok) return null;
		const { value } = await response.json();
		return typeof value === 'string' ? value : null;
	} catch {
		return null;
	}
}
