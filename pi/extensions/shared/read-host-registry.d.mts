export interface RegisteredHost {
	key: string;
	alias: string;
	enabled: boolean;
	hostId?: string;
	remote?: string;
	root?: string;
}
export function readHostRegistry(channel: "stable" | "dev"): RegisteredHost[];
