import { prisma } from "@/lib/db/client";
import { canConnectInstagramAccount } from "@/lib/instagram-accounts";
import {
  getUserInfo,
  listAssignedInstagramAccounts,
  subscribeInstagramAccountToWebhooks,
} from "@/lib/meta/client";
import { encryptToken } from "@/lib/meta/oauth";

export interface UnifiedConnectResult {
  accountCount: number;
  connected: number;
  skipped: number;
}

/**
 * Store every Instagram professional account assigned to a unified-login
 * token. `expiresIn` is seconds from now; omit it when Meta did not send an
 * expiry (system-user tokens often never expire).
 */
export async function connectAssignedInstagramAccounts({
  accessToken,
  expiresIn,
  workspaceId,
}: {
  accessToken: string;
  expiresIn?: number | null;
  workspaceId: string;
}): Promise<UnifiedConnectResult> {
  const assigned = await listAssignedInstagramAccounts(accessToken);
  if (assigned.length === 0) {
    return { accountCount: 0, connected: 0, skipped: 0 };
  }

  const tokenExpiresAt =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000)
      : null;
  const encryptedToken = encryptToken(accessToken);
  let connected = 0;
  let skipped = 0;

  for (const assignedAccount of assigned) {
    const instagramId = assignedAccount.id;
    const gate = await canConnectInstagramAccount({ workspaceId, instagramId });
    if (!gate.allowed) {
      skipped += 1;
      continue;
    }

    const profile = await getUserInfo(accessToken, instagramId);
    let webhookSubscribed = false;
    try {
      const subscription = await subscribeInstagramAccountToWebhooks(
        instagramId,
        accessToken
      );
      webhookSubscribed = Boolean(subscription.success);
    } catch (error) {
      console.warn(
        "[Instagram] Webhook subscription failed:",
        error instanceof Error ? error.message : error
      );
    }

    const data = {
      username: profile.username || assignedAccount.username || instagramId,
      name: profile.name ?? null,
      accessToken: encryptedToken,
      tokenExpiresAt,
      webhookSubscribed,
      needsReconnect: false,
    };
    const existing = await prisma.instagramAccount.findUnique({
      where: { instagramId },
    });
    if (existing) {
      const updated = await prisma.instagramAccount.updateMany({
        where: { id: existing.id, workspaceId, provider: "META" },
        data,
      });
      if (!updated.count) {
        skipped += 1;
        continue;
      }
    } else {
      await prisma.instagramAccount.create({
        data: {
          ...data,
          workspaceId,
          instagramId,
          provider: "META",
        },
      });
    }
    connected += 1;
  }

  return { accountCount: assigned.length, connected, skipped };
}
