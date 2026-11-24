// The last few lines of a block of text, for a failure a human or agent has to act on.
// Two report paths cap output this way (the dispatcher's gate rows and the focused-push
// gate), so the rule lives here rather than in both.
export function tail(text, lines = 12) {
  const parts = String(text).trimEnd().split('\n');
  return parts.slice(-lines).join('\n');
}
