// Scripted OpenAI-compatible chat endpoint for screenshot sessions.
// Replies are matched by the session's first prompt, so runs are repeatable.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const [scenarioPath, port] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

const text = (content) => typeof content === "string" ? content
	: Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : "";

function chunk(res, delta, finish = null) {
	res.write(`data: ${JSON.stringify({ id: "demo", object: "chat.completion.chunk", model: scenario.model.id,
		choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

function finish(res, reason) {
	chunk(res, {}, reason);
	res.write(`data: ${JSON.stringify({ id: "demo", object: "chat.completion.chunk", choices: [],
		usage: { prompt_tokens: 1200, completion_tokens: 300 } })}\n\n`);
	res.end("data: [DONE]\n\n");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function stream(res, body) {
	const messages = body.messages ?? [];
	const instructions = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => text(m.content)).join("\n");
	const conversation = messages.filter((m) => m.role === "user").map((m) => text(m.content)).join("\n");
	const session = scenario.sessions.find((s) => conversation.includes(s.prompt));
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	chunk(res, { role: "assistant", content: "" });

	if (instructions.includes("conversation labels")) {
		chunk(res, { content: JSON.stringify({ title: session?.title ?? "Demo conversation", slug: session?.slug ?? "demo" }) });
		return finish(res, "stop");
	}
	if (!session) {
		chunk(res, { content: "Done." });
		return finish(res, "stop");
	}
	const toolResults = messages.filter((m) => m.role === "tool").length;
	if (session.reasoning) {
		for (const word of session.reasoning.split(/(?<= )/)) { chunk(res, { reasoning_content: word }); await sleep(5); }
	}
	if (session.turn === "working") return; // Keep the request open so the session stays busy.
	if (session.turn === "approval" && toolResults === 0) {
		chunk(res, { tool_calls: [{ index: 0, id: "call_demo", type: "function",
			function: { name: session.tool.name, arguments: JSON.stringify(session.tool.arguments) } }] });
		return finish(res, "tool_calls");
	}
	for (const word of (session.reply ?? "Done.").split(/(?<= )/)) { chunk(res, { content: word }); await sleep(5); }
	finish(res, "stop");
}

createServer((req, res) => {
	let raw = "";
	req.on("data", (data) => { raw += data; });
	req.on("end", () => {
		if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
			res.writeHead(404).end();
			return;
		}
		stream(res, JSON.parse(raw)).catch((error) => { console.error(error); res.destroy(); });
	});
}).listen(Number(port), "127.0.0.1");
