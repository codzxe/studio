import { AuthOfflineNotice } from "@/components/auth/auth-offline-notice";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { SignInForm } from "@/components/auth/sign-in-form";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { authClient } from "@/lib/auth-client";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auth offline states (M9-H, AUD-5 §4): the (auth) layout banner (the shared
 * OfflineState, wired via useOnlineStatus) and the per-form submit gates.
 * jsdom defaults navigator.onLine to true, so each offline case redefines the
 * property and fires the event the browser would.
 */

const { requestPasswordReset } = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    resetPassword: vi.fn(),
    verifyEmail: vi.fn(),
    requestPasswordReset,
    signIn: {
      email: vi.fn().mockResolvedValue({ data: null, error: null }),
      social: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    signUp: {
      email: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  },
  SESSION_COOKIE_NAME: "better-auth.session_token",
}));

/** jsdom navigator.onLine shim. */
function setNavigatorOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
  window.dispatchEvent(new Event(online ? "online" : "offline"));
}

beforeEach(() => {
  vi.clearAllMocks();
  setNavigatorOnline(true);
});

describe("auth offline banner (layout-level OfflineState)", () => {
  it("renders nothing while online", () => {
    render(<AuthOfflineNotice />);
    expect(screen.queryByTestId("offline-state")).not.toBeInTheDocument();
  });

  it("renders the shared OfflineState with auth-honest copy when offline", () => {
    setNavigatorOnline(false);
    render(<AuthOfflineNotice />);
    expect(screen.getByTestId("offline-state")).toBeInTheDocument();
    expect(
      screen.getByText("You're offline. Reconnect to continue — what you've typed stays put."),
    ).toBeInTheDocument();
  });
});

describe("auth form offline gates", () => {
  it("sign-in refuses to submit while offline and says so inline", async () => {
    const user = userEvent.setup();
    render(<SignInForm />);
    await user.type(screen.getByLabelText(/^Email/), "alex@example.com");
    await user.type(screen.getByLabelText(/^Password/), "correct-horse-battery");
    await act(async () => {
      setNavigatorOnline(false);
    });
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByText("You're offline. Reconnect and sign in once you're back online."),
    ).toBeInTheDocument();
    expect(authClient.signIn.email).not.toHaveBeenCalled();
  });

  it("sign-up refuses to submit while offline and is honest that no account was created", async () => {
    const user = userEvent.setup();
    render(<SignUpForm />);
    await user.type(screen.getByLabelText(/^Name/), "Alex Jordan");
    await user.type(screen.getByLabelText(/^Email/), "alex@example.com");
    await user.type(screen.getByLabelText(/^Password/), "correct-horse-battery");
    const terms = screen.getByTestId("sign-up-terms") as HTMLInputElement;
    await user.click(terms);
    await act(async () => {
      setNavigatorOnline(false);
    });
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(
      await screen.findByText("You're offline. Reconnect and try again — no account was created."),
    ).toBeInTheDocument();
    expect(authClient.signUp.email).not.toHaveBeenCalled();
  });

  it("forgot-password refuses to send a reset link while offline", async () => {
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText(/^Email/), "alex@example.com");
    await act(async () => {
      setNavigatorOnline(false);
    });
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(
      await screen.findByText("You're offline. Reconnect and we'll send the reset link."),
    ).toBeInTheDocument();
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });
});
