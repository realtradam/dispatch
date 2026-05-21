import { getDatabase } from "./index.js";

export function getSetting(key: string): string | null {
	const db = getDatabase();
	const row = db.query("SELECT value FROM settings WHERE key = $key").get({ $key: key }) as { value: string } | null;
	return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
	const db = getDatabase();
	db.query(
		`INSERT INTO settings (key, value) VALUES ($key, $value)
		 ON CONFLICT(key) DO UPDATE SET value = $value`,
	).run({ $key: key, $value: value });
}

export function deleteSetting(key: string): void {
	const db = getDatabase();
	db.query("DELETE FROM settings WHERE key = $key").run({ $key: key });
}
