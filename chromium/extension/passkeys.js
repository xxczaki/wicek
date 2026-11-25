const credentials = navigator.credentials;

if (credentials) {
	const originalGet = credentials.get.bind(credentials);
	const originalCreate = credentials.create.bind(credentials);
	credentials.get = (options) =>
		options?.publicKey ? rejectPasskey() : originalGet(options);
	credentials.create = (options) =>
		options?.publicKey ? rejectPasskey() : originalCreate(options);
}

if (window.PublicKeyCredential) {
	PublicKeyCredential.isConditionalMediationAvailable = async () => false;
	PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable =
		async () => false;
}

function rejectPasskey() {
	return Promise.reject(
		new DOMException(
			'Passkeys are not available in this browser',
			'NotAllowedError',
		),
	);
}
