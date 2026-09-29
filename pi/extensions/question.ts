import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { getInteractionMode } from "./shared/interaction-mode";
import {
  notifyPiQuestion,
  suppressNextInputNotification,
} from "./shared/notifications";

const OptionSchema = Type.Object({
  label: Type.String({ minLength: 1, description: "Short display label for this choice" }),
  description: Type.Optional(Type.String({ description: "Concise explanation of this choice and its implications" })),
});

const QuestionParams = Type.Object({
  question: Type.String({ minLength: 1, description: "The question to ask the user" }),
  options: Type.Array(OptionSchema, {
    minItems: 2,
    maxItems: 4,
    description: "Two to four mutually exclusive choices. Freehand input is added by the UI.",
  }),
});

type QuestionOption = Static<typeof OptionSchema>;
type AnswerSource = "option" | "freehand";
type QuestionStatus = "answered" | "cancelled" | "unavailable" | "invalid";

type QuestionDetails = {
  question: string;
  options: QuestionOption[];
  status: QuestionStatus;
  answer?: string;
  source?: AnswerSource;
  error?: string;
};

const FREEHAND_OPTION = "Type another response…";

function details(
  question: string,
  options: QuestionOption[],
  status: QuestionStatus,
  extra: Partial<QuestionDetails> = {},
): QuestionDetails {
  return { question, options, status, ...extra };
}

function validateQuestion(question: string, options: QuestionOption[]): string | undefined {
  if (!question.trim()) {
    return "question must not be empty";
  }

  const labels = new Set<string>();
  for (const option of options) {
    const label = option.label.trim();
    if (!label) {
      return "option labels must not be empty";
    }
    if (labels.has(label)) {
      return `option labels must be unique: ${label}`;
    }
    labels.add(label);
  }
  return undefined;
}

function displayOption(option: QuestionOption, index: number): string {
  const description = option.description?.trim();
  return `${index + 1}. ${option.label}${description ? ` — ${description}` : ""}`;
}

export default function questionExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "question",
    label: "Question",
    description: "Ask the user one multiple-choice question, with an additional freehand response option.",
    promptSnippet: "Ask the user a multiple-choice question when a material decision requires their input.",
    promptGuidelines: [
      "Use question only when missing user input materially affects the outcome and repository evidence cannot resolve it.",
      "Provide 2-4 concise, mutually exclusive options with descriptions that explain their implications.",
      "Do not add an Other or freehand option; the question UI adds one automatically.",
      "Do not use question for tool permissions or approval of actions.",
      "If question reports that interaction is unavailable or cancelled, do not immediately retry it.",
    ],
    parameters: QuestionParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const question = params.question.trim();
      const options = params.options.map((option) => ({
        label: option.label.trim(),
        description: option.description?.trim() || undefined,
      }));
      const validationError = validateQuestion(question, options);
      if (validationError) {
        return {
          content: [{ type: "text", text: `Could not ask the question: ${validationError}.` }],
          details: details(question, options, "invalid", { error: validationError }),
          isError: true,
        };
      }

      if (getInteractionMode(ctx) === "noninteractive") {
        const error = "User input is unavailable in noninteractive mode.";
        return {
          content: [{
            type: "text",
            text: `${error} Do not retry during this run. Continue only if the choice is safe to infer; otherwise report that user input is required.`,
          }],
          details: details(question, options, "unavailable", { error }),
          isError: true,
        };
      }

      const displayedOptions = options.map(displayOption);
      displayedOptions.push(`${options.length + 1}. ${FREEHAND_OPTION}`);
      let promptCount = 0;
      const preparePrompt = () => {
        if (promptCount === 0) {
          notifyPiQuestion(ctx);
        } else {
          suppressNextInputNotification();
        }
        promptCount++;
      };

      while (true) {
        preparePrompt();
        const selectTitle = ctx.mode === "rpc"
          ? JSON.stringify({ kind: "pi_question_select", question })
          : question;
        const selected = await ctx.ui.select(selectTitle, displayedOptions, { signal });
        if (selected === undefined) {
          return {
            content: [{ type: "text", text: "The user cancelled the question without answering." }],
            details: details(question, options, "cancelled"),
          };
        }

        const selectedIndex = displayedOptions.indexOf(selected);
        if (selectedIndex >= 0 && selectedIndex < options.length) {
          const answer = options[selectedIndex].label;
          return {
            content: [{ type: "text", text: `User selected: ${answer}` }],
            details: details(question, options, "answered", { answer, source: "option" }),
          };
        }

        preparePrompt();
        const title = ctx.mode === "rpc"
          ? JSON.stringify({ kind: "pi_question_response", question })
          : `Your response to: ${question}`;
        const response = await ctx.ui.input(title, "Type your response", { signal });
        if (response === undefined) {
          continue;
        }
        const answer = response.trim();
        if (!answer) {
          ctx.ui.notify("Enter a response, or cancel to return to the choices.", "warning");
          continue;
        }
        return {
          content: [{ type: "text", text: `User wrote: ${answer}` }],
          details: details(question, options, "answered", { answer, source: "freehand" }),
        };
      }
    },
  });
}
