import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils";

// Radix owns focus trapping, scroll locking, Escape, aria-modal and the
// portal. The version this replaces hand-rolled the Escape key and the body
// overflow, and trapped nothing -- Tab walked straight out of the dialog into
// the page behind it.
const Root = DialogPrimitive.Root;
const Trigger = DialogPrimitive.Trigger;
const Close = DialogPrimitive.Close;

function Overlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-foreground/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

function Content({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <Overlay />
      {/* max-h/overflow on the panel, not the page: a long form scrolls inside
          the dialog instead of scrolling the frozen page behind it. */}
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 grid w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-lg duration-150 max-h-[calc(100dvh-2rem)] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function Header({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5 pr-8", className)} {...props} />;
}

function Footer({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function Title({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("font-display text-lg font-semibold leading-snug", className)}
      {...props}
    />
  );
}

function Description({ className, ...props }: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export const DialogRoot = Root;
export const DialogTrigger = Trigger;
export const DialogClose = Close;
export const DialogContent = Content;
export const DialogHeader = Header;
export const DialogFooter = Footer;
export const DialogTitle = Title;
export const DialogDescription = Description;

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
}

// The app's 12 dialogs are all "open/close/title/body/footer". They keep that
// shape; the primitives above are there for anything that needs more.
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  closeLabel = "Close",
}: DialogProps) {
  return (
    <Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Content>
        <Header>
          <Title>{title}</Title>
          {description && <Description>{description}</Description>}
        </Header>
        <div className="min-w-0">{children}</div>
        {footer && <Footer>{footer}</Footer>}
        <Close
          aria-label={closeLabel}
          className="absolute right-3 top-3 inline-flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </Close>
      </Content>
    </Root>
  );
}
