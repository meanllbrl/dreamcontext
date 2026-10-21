import { get } from "./api";
export async function InviteScreen() { const invites = await get("/v1/invites"); return invites; }
