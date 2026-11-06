// Scenario helpers for screenshots.sh.
//   prompts                 print "dir<TAB>prompt" per session
//   titled < status.json    print how many scenario sessions have their title
//   organization < status   print the frontend organization (groups) as JSON
//   conversation            print "index<TAB>title" of the conversation to show
import { readFileSync } from "node:fs";

const [mode] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(new URL("./scenario.json", import.meta.url), "utf8"));
const status = () => JSON.parse(readFileSync(0, "utf8"));
const titleOf = (row) => row.name ?? row.title;

function rowsByTitle(state) {
	const rows = new Map(state.state.sessions.map((row) => [titleOf(row), row]));
	return scenario.sessions.map((session) => rows.get(session.title));
}

if (mode === "prompts") {
	for (const session of scenario.sessions) console.log(`${session.dir}\t${session.prompt}`);
} else if (mode === "titled") {
	console.log(rowsByTitle(status()).filter(Boolean).length);
} else if (mode === "organization") {
	const state = status();
	const rows = rowsByTitle(state);
	const key = (row) => `service:${JSON.stringify([state.hostId, row.id])}`;
	const members = (group) => scenario.sessions.flatMap((session, index) => session.group === group ? [key(rows[index])] : []);
	console.log(JSON.stringify({
		version: 1,
		groups: scenario.groups.map((name, index) => ({ id: `group:demo:${index + 1}`, name, keys: members(name) })),
		ungrouped: members(undefined),
	}));
} else if (mode === "conversation") {
	const index = scenario.sessions.findIndex((session) => session.title === scenario.conversation);
	if (index < 0) throw new Error(`No session titled ${scenario.conversation}`);
	console.log(`${index}\t${scenario.conversation}`);
} else {
	throw new Error(`Unknown mode: ${mode}`);
}
