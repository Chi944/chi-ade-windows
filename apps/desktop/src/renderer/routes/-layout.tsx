import { Alerter } from "@superset/ui/atoms/Alert";
import type { ReactNode } from "react";
import { ThemedToaster } from "renderer/components/ThemedToaster";
import { AuthProvider } from "renderer/providers/AuthProvider";
import { ElectronTRPCProvider } from "renderer/providers/ElectronTRPCProvider";
import { MonacoProvider } from "renderer/providers/MonacoProvider";

export function RootLayout({ children }: { children: ReactNode }) {
	return (
		<ElectronTRPCProvider>
			<AuthProvider>
				<MonacoProvider>
					{children}
					<ThemedToaster />
					<Alerter />
				</MonacoProvider>
			</AuthProvider>
		</ElectronTRPCProvider>
	);
}
