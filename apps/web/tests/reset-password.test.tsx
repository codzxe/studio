import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { SignInForm } from "@/components/auth/sign-in-form";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reset-password journey (M9-H, closes the AUD-5 dead link): token parse
 * from the URL (`?token=…` / `?error=INVALID_TOKEN` — the shapes better-auth
 * 1.7.12's /reset-password/:token callback redirects with), inline
 * validation, the success redirect to /sign-in?reset=1, invalid-token error
 * copy, and the offline gate. The better-auth client and next/navigation are
 * mocked — these tests are about form behaviour, not the network.
 */

const { resetPassword, push, params } = vi.hoisted(() => ({
  resetPassword: vi.fn(),
  push: vi.fn(),
  params: { current: new URLSearchParams() },
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: () => ({
      push,
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
    resetPassword,
    verifyEmail: vi.fn(),
    signIn: {
      email: vi.fn().mockResolvedValue({ data: null, error: null }),
      social: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  },
  SESSION_COOKIE_NAME: "better-auth.session_token",
}));

/** jsdom navigator.onLine shim (offline-gate tests). */
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
  resetPassword.mockResolvedValue({ data: { status: true }, error: null });
  setNavigatorOnline(true);
});

describe("reset-password token parsing", () => {
  it("shows the missing-token state on a bare visit and links to request a link", () => {
    render(<ResetPasswordForm />);
    expect(screen.getByTestId("reset-password-missing-token")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request a reset link" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("shows the honest invalid-link state when better-auth redirects with ?error=INVALID_TOKEN", () => {
    params.current = new URLSearchParams("error=INVALID_TOKEN");
    render(<ResetPasswordForm />);
    expect(screen.getByTestId("reset-password-invalid")).toBeInTheDocument();
    expect(screen.getByText(/The link has expired or was already used./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request a new reset link" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("renders the new-password form when ?token= is present", () => {
    params.current = new URLSearchParams("token=tok-123");
    render(<ResetPasswordForm />);
    expect(screen.getByTestId("reset-password-form")).toBeInTheDocument();
    expect(screen.getByLabelText(/^New password/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Confirm new password/)).toBeInTheDocument();
  });
});

describe("reset-password form", () => {
  function renderWithToken() {
    params.current = new URLSearchParams("token=tok-123");
    render(<ResetPasswordForm />);
  }

  it("validates the new password inline on empty submit (empty confirm matches empty)", async () => {
    const user = userEvent.setup();
    renderWithToken();
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByText("Password must be at least 8 characters.")).toBeInTheDocument();
    // Empty confirm "matches" the empty new password — no dishonest mismatch claim.
    expect(screen.queryByText("The two passwords don't match.")).not.toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("rejects a confirm field that doesn't match the new password", async () => {
    const user = userEvent.setup();
    renderWithToken();
    await user.type(screen.getByLabelText(/^New password/), "correct-horse-battery");
    await user.type(screen.getByLabelText(/^Confirm new password/), "different-horse");
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByText("The two passwords don't match.")).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("resets via authClient.resetPassword and redirects to sign-in with a success note", async () => {
    const user = userEvent.setup();
    renderWithToken();
    await user.type(screen.getByLabelText(/^New password/), "correct-horse-battery");
    await user.type(screen.getByLabelText(/^Confirm new password/), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Reset password" }));

    expect(resetPassword).toHaveBeenCalledWith({
      newPassword: "correct-horse-battery",
      token: "tok-123",
    });
    await vi.waitFor(() => {
      expect(push).toHaveBeenCalledWith("/sign-in?reset=1");
    });
  });

  it("maps an INVALID_TOKEN submit error to the honest expired/used copy", async () => {
    resetPassword.mockResolvedValue({
      data: null,
      error: { code: "INVALID_TOKEN", message: "Invalid token", status: 400 },
    });
    const user = userEvent.setup();
    renderWithToken();
    await user.type(screen.getByLabelText(/^New password/), "correct-horse-battery");
    await user.type(screen.getByLabelText(/^Confirm new password/), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    expect(
      await screen.findByText(
        "This reset link has expired or was already used. Request a fresh one to continue.",
      ),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it("gates the submit while offline instead of firing a doomed request", async () => {
    const user = userEvent.setup();
    renderWithToken();
    await user.type(screen.getByLabelText(/^New password/), "correct-horse-battery");
    await user.type(screen.getByLabelText(/^Confirm new password/), "correct-horse-battery");
    await act(async () => {
      setNavigatorOnline(false);
    });
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    expect(
      await screen.findByText(
        "You're offline. Reconnect — your new password hasn't been changed yet.",
      ),
    ).toBeInTheDocument();
    expect(resetPassword).not.toHaveBeenCalled();
  });
});

describe("sign-in after a successful reset", () => {
  it("shows the password-updated note when arriving with ?reset=1", () => {
    params.current = new URLSearchParams("reset=1");
    render(<SignInForm />);
    expect(screen.getByTestId("sign-in-reset-note")).toHaveTextContent(
      "Password updated. Sign in with your new password.",
    );
  });

  it("hides the note on a plain sign-in visit", () => {
    render(<SignInForm />);
    expect(screen.queryByTestId("sign-in-reset-note")).not.toBeInTheDocument();
  });
});
