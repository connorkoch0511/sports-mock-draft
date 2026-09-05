import { apiGet } from "./api";

/** Your drafts, newest first. The server decides what "yours" means. */
export async function fetchMyDrafts() {
  const data = await apiGet("/me/drafts");
  return Array.isArray(data?.drafts) ? data.drafts : [];
}

export async function fetchMyBoards() {
  const data = await apiGet("/me/boards");
  return Array.isArray(data?.boards) ? data.boards : [];
}
