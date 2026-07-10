import type { OpenCodeModelProvider } from "@superset/shared/agent-command";
import { SiHuggingface, SiOllama } from "react-icons/si";

interface ProviderIconProps {
	provider: OpenCodeModelProvider;
	className?: string;
}

export function ProviderIcon({ provider, className }: ProviderIconProps) {
	if (provider === "huggingface") {
		return (
			<SiHuggingface
				aria-hidden="true"
				className={`text-[#ffd21e] ${className ?? ""}`}
			/>
		);
	}

	return (
		<SiOllama
			aria-hidden="true"
			className={`text-foreground ${className ?? ""}`}
		/>
	);
}
