import { asyncRouter } from "../asyncRouter";
const router = asyncRouter();
import { ok, fail } from "../platform";
import authMiddleware from "../middleware/auth";
import { summarizeConversation, ask } from "../services/aiService";
import { get as getSettings } from "../services/settingsService";

router.use(authMiddleware);

router.post("/summarize", async (req, res) => {
  const { conversationId } = req.body || {};
  if (!conversationId)
    return res.status(400).json(fail("BAD_REQUEST", "conversationId required"));
  try {
    const out = await summarizeConversation({
      userId: req.user.userId,
      conversationId,
    });
    return res.json(ok(out));
  } catch (e: any) {
    if (e && e.code === "FORBIDDEN")
      return res
        .status(403)
        .json(fail("FORBIDDEN", "Not a member of this conversation"));
    if (e && e.code === "AI_DISABLED")
      return res
        .status(503)
        .json(fail("AI_DISABLED", "AI is not configured on this deployment"));
    return res
      .status(502)
      .json(fail("AI_ERROR", (e && e.message) || "AI request failed"));
  }
});

router.post("/ask", async (req, res) => {
  const prompt = (req.body || {}).prompt;
  if (!prompt || !String(prompt).trim())
    return res.status(400).json(fail("BAD_REQUEST", "prompt required"));
  try {
    let style = "balanced";
    try {
      const sx = await getSettings(req.user.userId);
      style = (sx && (sx as any).agentStyle) || "balanced";
    } catch (_) {}
    const answer = await ask(String(prompt), style);
    res.json(ok({ answer }));
  } catch (e: any) {
    if (e && e.code === "AI_DISABLED")
      return res
        .status(503)
        .json(
          fail(
            "AI_DISABLED",
            "The AI assistant isn't configured in this environment.",
          ),
        );
    return res
      .status(502)
      .json(fail("AI_UPSTREAM", "Agen-X is temporarily unavailable."));
  }
});

export default router;
