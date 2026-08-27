import type { AuthSessionUser } from "@t3tools/contracts";
import { createContext, useContext, type ReactNode } from "react";

const CompadreSessionContext = createContext<AuthSessionUser | null>(null);

export function CompadreSessionProvider(props: {
  user: AuthSessionUser | null;
  children: ReactNode;
}) {
  return (
    <CompadreSessionContext.Provider value={props.user}>
      {props.children}
    </CompadreSessionContext.Provider>
  );
}

export function useCompadreSessionUser(): AuthSessionUser | null {
  return useContext(CompadreSessionContext);
}
