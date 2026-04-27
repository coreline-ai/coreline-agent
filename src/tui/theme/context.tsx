/** Theme React context — ThemeProvider + useTheme() hook. */

import React, { createContext, useContext, useEffect, useState } from "react";
import { themeRuntime } from "./runtime.js";
import type { ThemeStyles } from "./types.js";

const ThemeContext = createContext<ThemeStyles>(themeRuntime.getStyles());

interface ThemeProviderProps {
  themeId: string;
  children: React.ReactNode;
}

export function ThemeProvider({ themeId, children }: ThemeProviderProps) {
  const [styles, setStyles] = useState<ThemeStyles>(() => {
    themeRuntime.setTheme(themeId);
    return themeRuntime.getStyles();
  });

  useEffect(() => {
    themeRuntime.setTheme(themeId);
    setStyles(themeRuntime.getStyles());
  }, [themeId]);

  return <ThemeContext.Provider value={styles}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeStyles {
  return useContext(ThemeContext);
}
