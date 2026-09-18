import { Eye, EyeOff } from "lucide-react";
import { type InputHTMLAttributes, useState } from "react";
import { useT } from "../../lib/i18n";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function PasswordInput({ className, ...props }: Props) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        className={`block w-full rounded-md border border-brand-hairline px-3 py-2 pr-10 text-sm shadow-sm focus:border-brand-navy focus:outline-none focus:ring-1 focus:ring-brand-navy ${className ?? ""}`}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t("auth.hide_password") : t("auth.show_password")}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex items-center px-3 text-brand-muted hover:text-brand-ink"
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}
