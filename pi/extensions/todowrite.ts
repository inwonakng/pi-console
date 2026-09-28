import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const STATUS_VALUES = ["pending", "in_progress", "completed", "cancelled"] as const;
const PRIORITY_VALUES = ["high", "medium", "low"] as const;

const TodoItemSchema = Type.Object({
	content: Type.String({ description: "Brief description of the task" }),
	status: StringEnum(STATUS_VALUES, {
		description: "Current status of the task: pending, in_progress, completed, or cancelled",
	}),
	priority: StringEnum(PRIORITY_VALUES, {
		description: "Priority level of the task: high, medium, or low",
	}),
});

const TodoWriteParams = Type.Object({
	todos: Type.Array(TodoItemSchema, { description: "The complete updated todo list for the current session" }),
});

type TodoItem = Static<typeof TodoItemSchema>;

type TodoWriteDetails = {
	todos: TodoItem[];
	updatedAt: string;
	error?: string;
};

let todos: TodoItem[] = [];

function cloneTodos(items: TodoItem[]) {
	return items.map((item) => ({ ...item }));
}

function validateTodos(items: TodoItem[]) {
	const errors: string[] = [];
	let inProgressCount = 0;

	items.forEach((item, index) => {
		if (item.content.trim() === "") {
			errors.push(`todo ${index + 1}: content must not be empty`);
		}
		if (item.status === "in_progress") {
			inProgressCount++;
		}
	});

	if (inProgressCount > 1) {
		errors.push("only one todo may be in_progress at a time");
	}

	return errors;
}

function formatTodo(item: TodoItem) {
	const marker = item.status === "completed" ? "✓" : item.status === "in_progress" ? "◉" : item.status === "cancelled" ? "⊘" : "○";
	return `${marker} [${item.priority}] ${item.content}`;
}

function updateUI(ctx: ExtensionContext) {
	const active = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
	const completed = todos.filter((todo) => todo.status === "completed").length;

	if (todos.length === 0) {
		ctx.ui.setStatus("pi-todos", undefined);
		ctx.ui.setWidget("pi-todos", undefined);
		return;
	}

	ctx.ui.setStatus("pi-todos", `todos ${completed}/${todos.length}`);

	if (active.length === 0) {
		ctx.ui.setWidget("pi-todos", undefined);
		return;
	}

	ctx.ui.setWidget(
		"pi-todos",
		active.map(formatTodo),
	);
}

function reconstructState(ctx: ExtensionContext) {
	todos = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== "todowrite") continue;

		const details = message.details as TodoWriteDetails | undefined;
		if (details && Array.isArray(details.todos)) {
			todos = cloneTodos(details.todos);
		}
	}
	updateUI(ctx);
}

function todoListText(items: TodoItem[]) {
	if (items.length === 0) {
		return "No todos";
	}
	return items.map(formatTodo).join("\n");
}

export default function todowriteExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	pi.registerTool({
		name: "todowrite",
		label: "Todo Write",
		description:
			"Create and maintain a structured task list for the current coding session. Tracks progress and keeps todo statuses current.",
		promptSnippet: "Create or update the session todo list for multi-step coding work.",
		promptGuidelines: [
			"Use todowrite proactively for non-trivial work with 3+ distinct steps, multiple user tasks, or explicit planning/todo requests.",
			"Do not use todowrite for single straightforward tasks or purely informational answers.",
			"When using todowrite, submit the complete current todo list, not just the changed item.",
			"Keep exactly one todowrite item in_progress while actively working, mark completed items promptly, and add follow-up items discovered during work.",
		],
		parameters: TodoWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const nextTodos = cloneTodos(params.todos).map((item) => ({
				...item,
				content: item.content.trim(),
			}));
			const errors = validateTodos(nextTodos);
			if (errors.length > 0) {
				return {
					content: [{ type: "text", text: `Could not update todos:\n${errors.map((error) => `- ${error}`).join("\n")}` }],
					details: { todos: cloneTodos(todos), updatedAt: new Date().toISOString(), error: errors.join("; ") } as TodoWriteDetails,
					isError: true,
				};
			}

			todos = nextTodos;
			updateUI(ctx);

			return {
				content: [{ type: "text", text: todoListText(todos) }],
				details: { todos: cloneTodos(todos), updatedAt: new Date().toISOString() } as TodoWriteDetails,
			};
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current session todo list",
		handler: async (_args, ctx) => {
			reconstructState(ctx);
			ctx.ui.notify(todoListText(todos), "info");
		},
	});
}
