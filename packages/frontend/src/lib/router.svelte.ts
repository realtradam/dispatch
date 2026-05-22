type Page = "dashboard" | "agent-builder";

let currentPage = $state<Page>("dashboard");

export const router = {
	get page() {
		return currentPage;
	},
	navigate(page: Page) {
		currentPage = page;
	},
};
