import { NextRequest, NextResponse } from "next/server";
import { isUnifiedLoginMode } from "@/lib/env";
import { connectAssignedInstagramAccounts } from "@/lib/meta/unified-connect";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

const MAX_TOKEN_LENGTH = 4096;

/**
 * Owner fallback when the Facebook Login dialog cannot finish in the browser.
 * The pasted value is a dashboard-generated system-user token. It is encrypted
 * and stored the same way an OAuth code exchange would store it.
 */
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (context.role !== "OWNER") {
    return NextResponse.json(
      { success: false, error: "Only the workspace owner can connect a pasted token." },
      { status: 403 }
    );
  }
  if (!isUnifiedLoginMode()) {
    return NextResponse.json(
      { success: false, error: "Unified login is not enabled." },
      { status: 400 }
    );
  }

  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return NextResponse.json(
      { success: false, error: "Token is required." },
      { status: 400 }
    );
  }

  try {
    const result = await connectAssignedInstagramAccounts({
      accessToken: token,
      workspaceId: context.workspaceId,
    });
    if (result.accountCount === 0) {
      return NextResponse.json(
        { success: false, error: "no_accounts_shared" },
        { status: 422 }
      );
    }
    if (result.connected === 0) {
      return NextResponse.json(
        { success: false, error: "already_connected" },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Token connect failed";
    console.error("[Instagram connect-token]", message);
    return NextResponse.json(
      { success: false, error: message.slice(0, 200) },
      { status: 502 }
    );
  }
}
