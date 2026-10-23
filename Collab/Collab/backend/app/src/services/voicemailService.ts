import { db } from "../platform";
import { serializeVoicemail } from "../serialize";
import { httpErr as deny } from "../optimization/httpError";

async function leave({
  fromUserId,
  toUserId,
  callId,
  durationSec,
  mime,
  data,
  encrypted,
}: any) {
  if (fromUserId === toUserId)
    throw deny(400, "You cannot leave a voicemail for yourself.");
  const recipient = await db.users.getById(toUserId);
  if (!recipient) throw deny(404, "Recipient not found.");
  const file = await db.files.create({
    uploaderId: fromUserId,
    name: "Voicemail",
    mime: mime || "audio/webm",
    size: data ? data.length : 0,
    data,
    conversationId: null,
    encryptionVersion: encrypted ? encrypted.version || 1 : 0,
    ciphertextMeta: encrypted || null,
  });
  const vm = await db.voicemails.create({
    callId: callId || null,
    fromUser: fromUserId,
    toUser: toUserId,
    fileId: file.id,
    durationSec: durationSec || 0,
  });
  return serializeVoicemail(vm);
}

async function listForUser(userId: string) {
  const vms = await db.voicemails.listForUser(userId);
  return Promise.all(vms.map((vm: any) => serializeVoicemail(vm)));
}

async function markListened({ id, userId }: any) {
  const vm = await db.voicemails.getById(id);
  if (!vm) throw deny(404, "Voicemail not found.");
  if (vm.toUser !== userId)
    throw deny(403, "You can only update your own voicemails.");
  return serializeVoicemail(await db.voicemails.markListened(id));
}

async function remove({ id, userId }: any) {
  const vm = await db.voicemails.getById(id);
  if (!vm) throw deny(404, "Voicemail not found.");
  if (vm.toUser !== userId)
    throw deny(403, "You can only delete your own voicemails.");
  // Delete the voicemail row first (captures deleted=true), then its audio
  // file. Doing it the other way round cascades the row away first.
  const res = await db.voicemails.remove(id);
  await db.files.remove(vm.fileId);
  return res;
}

// Audio access is voicemail-scoped: the sender or the recipient may play it
// (the files uploader-only rule would lock out the recipient).
async function getAudio({ voicemailId, userId }: any) {
  const vm = await db.voicemails.getById(voicemailId);
  if (!vm) return null;
  if (vm.toUser !== userId && vm.fromUser !== userId) return null;
  return db.files.getData(vm.fileId);
}

export { leave, listForUser, markListened, remove, getAudio };
