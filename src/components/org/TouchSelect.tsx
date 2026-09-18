import type { JSX } from "react";
import { Select, type SelectProps } from "../ui/Select";

// Select's trigger is py-2 text-sm, which lands at about 36px — under the 44px
// floor Button, Checkbox and ListRow already keep, and these screens are used
// on phones in a workshop. The arbitrary variant raises only this instance's
// trigger; fixing the primitive itself changes every other screen in the app
// and belongs in its own PR.
const TOUCH_TRIGGER = "[&>button]:min-h-12 [&>button]:text-base";

export function TouchSelect<T extends string = string>(props: SelectProps<T>): JSX.Element {
  const { className = "", ...rest } = props;
  return <Select<T> {...rest} className={`${TOUCH_TRIGGER} ${className}`} />;
}
