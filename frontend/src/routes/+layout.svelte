<script lang="ts">
	// Import necessary modules and components
	import '../app.css';
	import { workspaces } from '$lib/stores/workspace';

	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import ProjectList from '$lib/components/ProjectList.svelte';
	import Header from '$lib/components/Header.svelte';
	import {
		getCurrentWorkspaceId,
		removeLocalStorage,
		setCurrentWorkspaceId
	} from '$lib/utils/localStorage';
	import { getProjects, getWorkspaces, type Project } from '$lib/api/BeoApi';
	import { onMount } from 'svelte';
	import { projects } from '$lib/stores/configurations';
	import Toast from '$lib/components/Toast.svelte';
	import { isAuthenticated, auth } from '$lib/stores/auth';
	import DesktopMenuBar from '$lib/components/desktop/DesktopMenuBar.svelte';
	import BackendStatus from '$lib/components/desktop/BackendStatus.svelte';
	import { isDesktopMode } from '$lib/utils/desktopConfig';

	let searchTerm = '';
	let activeTab = 'routes';
	let panelWidth: number = 18; // Panel width in rem units (w-72 = 18rem)
	let projectListComponent: ProjectList;

	// Check authentication from localStorage
	$: isLoginPage = $page.url.pathname === '/login';
	$: isLandingPage = $page.url.pathname === '/';

	async function fetchConfigs(workspaceId: string) {
		try {
			const projectsData = await getProjects();
			projects.set(projectsData);
		} catch (err) {
			console.error('Failed to fetch projects:', err);
		}
	}

	async function fetchWorkspaces() {
		try {
			const workspacesData = await getWorkspaces();
			workspaces.loadAll();

			// Get current workspace from localStorage or use the first one
			const currentWorkspaceId = getCurrentWorkspaceId();

			// If we have workspaces but no current one is selected, use the first one
			if (workspacesData.length > 0) {
				if (!currentWorkspaceId) {
					// Set the first workspace as current
					setCurrentWorkspaceId(workspacesData[0].id);
					workspaces.setCurrent(workspacesData[0].id);
					return workspacesData[0].id;
				} else {
					// Verify the stored ID exists in our workspaces
					const exists = workspacesData.some((w) => w.id === currentWorkspaceId);
					if (exists) {
						workspaces.setCurrent(currentWorkspaceId);
						return currentWorkspaceId;
					} else {
						// If stored ID doesn't exist, use first workspace
						setCurrentWorkspaceId(workspacesData[0].id);
						workspaces.setCurrent(workspacesData[0].id);
						return workspacesData[0].id;
					}
				}
			}
			return null;
		} catch (err) {
			console.error('Failed to fetch workspaces:', err);
			return null;
		}
	}

	onMount(async () => {
		console.log('onMount: layout');
		
		// Skip authentication checks for landing page
		if (isLandingPage) {
			// If user is authenticated, still initialize workspaces for the landing page
			if ($isAuthenticated) {
				try {
					const currentWorkspaceId = await fetchWorkspaces();
					if (currentWorkspaceId) {
						setCurrentWorkspaceId(currentWorkspaceId);
						await fetchConfigs(currentWorkspaceId);
					}
				} catch (e) {
					console.error('Failed to fetch workspaces for authenticated user on landing page:', e);
				}
			}
			return;
		}
		
		if (!$isAuthenticated && !isLoginPage) {
			try {
				// First check authentication by getting workspaces
				await getWorkspaces();
				await auth.initialize(); // This will set isAuthenticated to true if token is valid
				await goto('/home');
			} catch (e) {
				console.error('Failed to authenticate:', e);
				auth.logout(); // This will set isAuthenticated to false
				await goto('/login');
			}
		}

		async function initialize() {
			if ($isAuthenticated) {
				// First fetch workspaces and get current workspace ID
				const currentWorkspaceId = await fetchWorkspaces();

				// If we have a valid workspace ID, fetch projects for that workspace
				if (currentWorkspaceId) {
					//set localStorage for current workspace
					setCurrentWorkspaceId(currentWorkspaceId);
					await fetchConfigs(currentWorkspaceId);
				}
			}
			return () => {};
		}

		initialize();
	});

	function handleProjectStart(event: CustomEvent<Project>) {
		const project = event.detail;
		projects.update((configs) =>
			configs.map((c) => (c.name === project.name ? { ...c, inUse: true } : c))
		);
	}

	function handleProjectStop(event: CustomEvent<Project>) {
		const project = event.detail;
		projects.update((configs) =>
			configs.map((c) => (c.name === project.name ? { ...c, inUse: false } : c))
		);
	}

	function handleTabChange(event: CustomEvent<string>) {
		activeTab = event.detail;
		if (activeTab === 'routes') {
			goto('/home');
		} else if (activeTab === 'settings') {
			goto('/settings');
		}
		// Note: We don't need special navigation for 'workspace-settings' or 'instance-settings'
		// as they are handled directly by the ContentArea component using the activeTab store
	}

	function handleLogout() {
		auth.logout(); // This will set isAuthenticated to false and remove auth token
		removeLocalStorage('currentWorkspaceId');
		goto('/login');
		window.location.reload();
	}
</script>

{#if isLoginPage || isLandingPage || !$isAuthenticated}
	<slot />
{:else}
	<!-- Desktop Menu Bar (only shown in desktop mode) -->
	{#if isDesktopMode()}
		<DesktopMenuBar />
	{/if}
	
	<div class="min-h-screen w-full theme-bg-tertiary theme-text-primary font-sans transition-colors {isDesktopMode() ? 'pt-8' : ''}">
		<div class="mx-auto flex h-screen">
			<ProjectList {searchTerm} bind:this={projectListComponent} />

			<div class="flex-1 flex flex-col overflow-hidden">
				<Header on:tabChange={handleTabChange} {handleLogout} />
				
				<!-- Backend Status (only shown in desktop mode) -->
				{#if isDesktopMode()}
					<BackendStatus />
				{/if}
				
				<div class="flex-1 overflow-auto theme-bg-primary">
					<slot {activeTab} />
				</div>
			</div>
		</div>
	</div>
{/if}

<Toast />

<style global>
</style>
