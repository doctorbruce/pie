// Private browsing and full storage must not prevent chatting.
export function stored(key: string): string {
	try {
		return localStorage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

export function store(key: string, value: string) {
	try {
		if (value) localStorage.setItem(key, value);
		else localStorage.removeItem(key);
	} catch {
		// Drafts remain available in memory for this tab.
	}
}
