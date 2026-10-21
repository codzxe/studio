import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { SignInForm } from "@/components/auth/sign-in-form";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * §8.2 auth forms: inline validation states, show/hide password, the
 * unchecked-by-default terms checkbox, and the honest reset success state.
 * The better-auth client is mocked — these tests are about form behaviour,
 * not the network.
 */

const { requestPasswordReset } = vi.hoisted(() => ({
  requestPasswordReset: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: {
      email: vi.fn().mockResolvedValue({ data: null, error: null }),
      social: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    signUp: {
      email: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
    requestPasswordReset,
    organization: {
      getInvitation: vi.fn().mockResolvedValue({ data: null, error: null }),
      acceptInvitation: vi.fn().mockResolvedValue({ data: null, error: null }),
      rejectInvitation: vi.fn().mockResolvedValue({ data: null, error: null }),
    },
  },
  SESSION_COOKIE_NAME: "better-auth.session_token",
}));

beforeEach(() => {
  vi.clearAllMocks();
  requestPasswordReset.mockResolvedValue({ data: null, error: null });
});

describe("sign-in form", () => {
  it("renders the heading, OAuth buttons and the email divider", () => {
    render(<SignInForm />);
    expect(screen.getByText("Sign in to Studio.")).toBeInTheDocument();
    expect(screen.getByTestId("oauth-buttons")).toBeInTheDocument();
    expect(screen.getByText("Continue with Google")).toBeInTheDocument();
    expect(screen.getByText("Continue with GitHub")).toBeInTheDocument();
    expect(screen.getByText("or continue with email")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("shows inline validation errors on empty submit and stays put", async () => {
    const user = userEvent.setup();
    render(<SignInForm />);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Password must be at least 8 characters.")).toBeInTheDocument();
    expect(screen.getByTestId("sign-in-form")).toBeInTheDocument();
  });

  it("toggles password visibility with an accessible control", async () => {
    const user = userEvent.setup();
    render(<SignInForm />);
    const input = screen.getByLabelText(/^Password/) as HTMLInputElement;
    expect(input.type).toBe("password");
    const toggle = screen.getByRole("button", { name: "Show password" });
    await user.click(toggle);
    expect(input.type).toBe("text");
    expect(screen.getByRole("button", { name: "Hide password" })).toBeInTheDocument();
  });
});

describe("sign-up form", () => {
  it("states the trial terms up front and starts the terms checkbox unchecked", () => {
    render(<SignUpForm />);
    expect(screen.getByTestId("sign-up-trial-copy")).toHaveTextContent(
      "14 days free, then $29/mo. Card required today. Cancel anytime.",
    );
    const terms = screen.getByTestId("sign-up-terms") as HTMLInputElement;
    expect(terms).not.toBeChecked();
  });

  it("requires the terms checkbox before creating an account", async () => {
    const user = userEvent.setup();
    render(<SignUpForm />);
    await user.type(screen.getByLabelText(/^Name/), "Alex Jordan");
    await user.type(screen.getByLabelText(/^Email/), "alex@example.com");
    await user.type(screen.getByLabelText(/^Password/), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(
      await screen.findByText("You need to accept the terms to continue."),
    ).toBeInTheDocument();
  });

  it("shows per-field errors on empty submit", async () => {
    const user = userEvent.setup();
    render(<SignUpForm />);
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Tell us your name — two characters or more.")).toBeInTheDocument();
    expect(screen.getByText("Password must be at least 8 characters.")).toBeInTheDocument();
  });
});

describe("forgot-password form", () => {
  it("validates the email inline", async () => {
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
  });

  it("renders the honest success state (no account-existence leak)", async () => {
    const user = userEvent.setup();
    render(<ForgotPasswordForm />);
    await user.type(screen.getByLabelText(/^Email/), "alex@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByTestId("forgot-password-sent")).toBeInTheDocument();
    expect(screen.getByText("Check your inbox.")).toBeInTheDocument();
    expect(
      screen.getByText(/If an account exists for that address, a reset link is on its way./),
    ).toBeInTheDocument();
    expect(requestPasswordReset).toHaveBeenCalledWith({
      email: "alex@example.com",
      redirectTo: expect.stringContaining("/reset-password"),
    });
  });
});
