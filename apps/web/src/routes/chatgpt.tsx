import { createFileRoute } from "@tanstack/react-router";

import { ChatGptPage } from "../components/chatgpt/ChatGptPage";

export const Route = createFileRoute("/chatgpt")({
  component: ChatGptPage,
});
