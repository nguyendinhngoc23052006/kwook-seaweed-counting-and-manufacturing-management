import { Eye, EyeOff } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { useT } from "../../lib/i18n";
import { cn } from "../../lib/utils";
import { Input } from "./Input";

type Props = Omit<ComponentProps<"input">, "type">;

export function PasswordInput({ className, ...props }: Props) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input type={visible ? "text" : "password"} className={cn("pr-12", className)} {...props} />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t("auth.hide_password") : t("auth.show_password")}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground"
      >
        {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
