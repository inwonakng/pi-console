import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

type JsonRecord = Record<string, unknown>;

export function readSessionRecords(sessionFile: string): JsonRecord[] {
	return readFileSync(sessionFile, "utf8")
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as JsonRecord);
}

export function recordId(record: JsonRecord): string | undefined {
	return typeof record.id === "string" ? record.id : undefined;
}

export function parentId(record: JsonRecord): string | null | undefined {
	if (record.parentId === null) {
		return null;
	}
	return typeof record.parentId === "string" ? record.parentId : undefined;
}

export function collectDeletedIds(records: JsonRecord[], targetId: string): Set<string> {
	const deleted = new Set<string>([targetId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const record of records) {
			const id = recordId(record);
			const parent = parentId(record);
			if (!id || deleted.has(id) || !parent || !deleted.has(parent)) {
				continue;
			}
			deleted.add(id);
			changed = true;
		}
	}
	return deleted;
}

export function locationWorkspaceId(record: { type?: unknown; customType?: unknown; data?: unknown }): string | undefined {
	if (record.type !== "custom" || record.customType !== "pi-workspace-location"
		|| !record.data || typeof record.data !== "object") {
		return undefined;
	}
	const workspaceId = (record.data as Record<string, unknown>).workspaceId;
	return typeof workspaceId === "string" && workspaceId !== "" ? workspaceId : undefined;
}

export function workspaceIdsRemovedWithSubtree(records: JsonRecord[], deletedIds: Set<string>): string[] {
	const deleted = new Set<string>();
	const surviving = new Set<string>();
	for (const record of records) {
		const workspaceId = locationWorkspaceId(record);
		const id = recordId(record);
		if (!workspaceId || !id) continue;
		(deletedIds.has(id) ? deleted : surviving).add(workspaceId);
	}
	return [...deleted].filter((id) => !surviving.has(id));
}

function makeId(existingIds: Set<string>): string {
	for (let attempt = 0; attempt < 100; attempt++) {
		const id = Math.floor(Math.random() * 0xffffffff)
			.toString(16)
			.padStart(8, "0")
			.slice(0, 8);
		if (!existingIds.has(id)) {
			return id;
		}
	}
	throw new Error("Could not allocate unique session entry id");
}

function appendLeafMarker(records: JsonRecord[], leafParentId: string | null): string {
	const existingIds = new Set(records.map(recordId).filter((id): id is string => typeof id === "string"));
	const id = makeId(existingIds);
	records.push({
		type: "custom",
		id,
		parentId: leafParentId,
		timestamp: new Date().toISOString(),
		customType: "pi-tree-delete-leaf",
		data: { reason: "preserve active leaf after subtree deletion" },
	});
	return id;
}

export function planSessionDeletion(records: JsonRecord[], deletedIds: Set<string>, leafParentId: string | null) {
	const kept = records.filter((record) => record.type === "session" || !deletedIds.has(recordId(record) ?? ""));
	const keptIds = new Set(kept.filter((record) => record.type !== "session").map(recordId));
	const orphan = kept.find((record) => {
		const parent = parentId(record);
		return typeof parent === "string" && !keptIds.has(parent);
	});
	if (orphan) throw new Error(`Deletion would orphan retained entry ${recordId(orphan) ?? "unknown"}.`);
	if (leafParentId !== null && !keptIds.has(leafParentId)) {
		throw new Error(`Cannot retain deleted leaf ${leafParentId}.`);
	}
	const lastKeptId = recordId(kept[kept.length - 1]!);
	const desiredLeafId = leafParentId === null || lastKeptId !== leafParentId
		? appendLeafMarker(kept, leafParentId)
		: leafParentId;
	return { records: kept, desiredLeafId, deletedCount: deletedIds.size };
}

export function writeJsonlFile(path: string, records: object[]): void {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
		renameSync(temporary, path);
	} finally {
		rmSync(temporary, { force: true });
	}
}
