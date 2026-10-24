import { VerifyEmailPanel } from "@/components/auth/verify-email-panel";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Verify-email panel (M9-H): verifying → success/failure phases, honest §14
 * copy per better-auth error code, the server-side ?error= redirect shape,
 * the bare-visit state, and the offline recovery path. The better-auth client
 * is mocked — these tests are about the state machine, not the network.
 */

const { verifyEmail, params } = vi.hoisted(() => ({
  verifyEmail: vi.fn(),
  params: { current: new URLSearchParams() },
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    }),
    useSearchParams: () => params.current,
    usePathname: () => "/",
  };
});

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    verifyEmail,
    resetPassword: vi.fn(),
  },
  SESSION_COOKIE_NAME: "better-auth.session_token",
}));

/** jsdom navigator.onLine shim (offline tests). */
function setNavigatorOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

beforeEach(() => {
  vi.clearAllMocks();
  params.current = new URLSearchParams();
  verifyEmail.mockResolvedValue({ data: { status: true, user: null }, error: null });
  setNavigatorOnline(true);
});

describe("verify-email panel", () => {
  it("verifies while a token is in flight, then shows the success state", async () => {
    let resolveVerification: (value: unknown) => void = () => {};
    verifyEmail.mockReturnValue(
      new Promise((resolve) => {
        resolveVerification = resolve;
      }),
    );
    params.current = new URLSearchParams("token=jwt-abc");
    render(<VerifyEmailPanel />);

    expect(screen.getByTestId("verify-email-verifying")).toBeInTheDocument();
    expect(verifyEmail).toHaveBeenCalledWith({ query: { token: "jwt-abc" } });

    resolveVerification({ data: { status: true, user: null }, error: null });
    expect(await screen.findByTestId("verify-email-success")).toBeInTheDocument();
    expect(screen.getByText("Email verified.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Sign in$/ })).toHaveAttribute("href", "/sign-in");
  });

  it("maps INVALID_TOKEN to the honest link-dead copy (still no dead end)", async () => {
    params.current = new URLSearchParams("token=jwt-abc");
    verifyEmail.mockResolvedValue({
      data: null,
      error: { code: "INVALID_TOKEN", message: "Invalid token", status: 401 },
    });
    render(<VerifyEmailPanel />);
    expect(await screen.findByTestId("verify-email-failure")).toBeInTheDocument();
    expect(screen.getByText("This verification link doesn't work anymore.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Sign in$/ })).toHaveAttribute("href", "/sign-in");
  });

  it("maps TOKEN_EXPIRED and USER_NOT_FOUND to their own honest headings", async () => {
    params.current = new URLSearchParams("token=jwt-abc");
    verifyEmail.mockResolvedValue({
      data: null,
      error: { code: "TOKEN_EXPIRED", message: "Token expired", status: 401 },
    });
    const { unmount } = render(<VerifyEmailPanel />);
    expect(await screen.findByText("This verification link expired.")).toBeInTheDocument();
    unmount();

    verifyEmail.mockResolvedValue({
      data: null,
      error: { code: "USER_NOT_FOUND", message: "User not found", status: 401 },
    });
    render(<VerifyEmailPanel />);
    expect(await screen.findByText("No account matches this link anymore.")).toBeInTheDocument();
  });

  it("handles the honest not-enabled state (VERIFICATION_EMAIL_NOT_ENABLED)", async () => {
    params.current = new URLSearchParams("token=jwt-abc");
    verifyEmail.mockResolvedValue({
      data: null,
      error: {
        code: "VERIFICATION_EMAIL_NOT_ENABLED",
        message: "Verification email isn't enabled",
        status: 400,
      },
    });
    render(<VerifyEmailPanel />);
    expect(
      await screen.findByText("Email verification isn't switched on here yet."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /you can sign in with your email and password while we finish wiring this up./,
      ),
    ).toBeInTheDocument();
  });

  it("handles a server-side failure redirect (?error=…) without calling the client", async () => {
    params.current = new URLSearchParams("error=INVALID_TOKEN");
    render(<VerifyEmailPanel />);
    expect(await screen.findByTestId("verify-email-failure")).toBeInTheDocument();
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it("shows the honest nothing-to-verify state on a bare visit", () => {
    render(<VerifyEmailPanel />);
    expect(screen.getByTestId("verify-email-idle")).toBeInTheDocument();
    expect(screen.getByText("Nothing to verify here.")).toBeInTheDocument();
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it("recovers from an offline verification attempt with honest copy and a retry", async () => {
    params.current = new URLSearchParams("token=jwt-abc");
    verifyEmail.mockRejectedValue(new TypeError("Failed to fetch"));
    setNavigatorOnline(false);
    render(<VerifyEmailPanel />);

    expect(await screen.findByTestId("verify-email-failure")).toBeInTheDocument();
    expect(screen.getByText("You're offline.")).toBeInTheDocument();
    expect(
      screen.getByText(
        /The verification request couldn't leave your browser. Reconnect, then try again/,
      ),
    ).toBeInTheDocument();

    // Back online: the retry re-enters the verifying phase and succeeds.
    verifyEmail.mockResolvedValue({ data: { status: true, user: null }, error: null });
    await act(async () => {
      setNavigatorOnline(true);
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("verify-email-success")).toBeInTheDocument();
  });
});
