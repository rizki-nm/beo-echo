import type { User, Workspace } from '$lib/types/User';
import { auth } from '$lib/stores/auth';
import { getCurrentWorkspaceId } from '$lib/utils/localStorage';
import { apiClient } from './apiClient';
import type { Rule } from './rulesApi';

interface AuthCredentials {
	username: string;
	password: string;
}

export interface PublicConfigResponse {
	is_authenticated: boolean;
	landing_enabled: boolean;
	mock_url_format: string;
}

// Project search types (migrated from projectsApi.ts)
export interface ProjectSearchResult {
	id: string;
	name: string;
	alias: string;
	workspace_id: string;
	workspace_name: string;
}

export interface AliasAvailabilityResponse {
	available: boolean;
	projects: ProjectSearchResult[];
}

export interface ConfigResponse {
	uuid: string;
	name: string;
	configFile: string;
	port: number;
	url: string;
	size: string;
	modified: string;
	inUse: boolean;
}

export type Project = {
	id: string;
	name: string;
	mode: string;
	status?: string; // 'running', 'stopped', or 'error'
	active_proxy_id: string | null;
	active_proxy: ProxyTarget | null;
	endpoints: Endpoint[];
	proxy_targets: ProxyTarget[] | null;
	created_at: Date;
	updated_at: Date;
	url: string;
	alias: string;
	workspace_id: string;
}

export type RequestLog = {
	id: string;
	project_id: string;
	method: string;
	path: string;
	query_params: string;
	request_headers: string;
	request_body: string;
	response_status: number;
	response_body: string;
	response_headers: string;
	latency_ms: number;
	execution_mode: string;
	matched: boolean;
	bookmark?: boolean;
	created_at: Date;
}

export type Endpoint = {
	id: string;
	project_id: string;
	method: string;
	path: string;
	enabled: boolean;
	response_mode: string;
	responses: Response[];
	// Proxy fields
	use_proxy: boolean;
	proxy_target_id: string | null;
	proxy_target?: ProxyTarget | null;
	created_at: Date;
	updated_at: Date;
	documentation: string;
	advance_config?: string; // Advanced configuration (e.g. timeout) as JSON string
}

export type Response = {
	id: string;
	endpoint_id: string;
	status_code: number;
	body: string;
	headers: string;
	priority: number;
	delay_ms: number;
	stream: boolean;
	enabled: boolean;
	note: string;
	is_fallback: boolean;
	rules: Rule[] | null;
	created_at: Date;
	updated_at: Date;
}

export type ProxyTarget = {
	id: string;
	project_id: string;
	url: string;
	label: string;
	created_at: Date;
	updated_at: Date;
}

// Add request interceptor to add auth header with JWT token
apiClient.interceptors.request.use(
	(config) => {
		// Get JWT token from auth store
		const token = auth.getToken();

		if (config.headers && token) {
			config.headers.Authorization = `Bearer ${token}`;
		}
		return config;
	},
	(error) => {
		return Promise.reject(error);
	}
);

let isRedirectingToLogin = false;
let isRefreshing = false;
let refreshPromise: Promise<string> | null = null;
let failedQueue: Array<{
	resolve: (value: any) => void;
	reject: (reason?: any) => void;
}> = [];

const processQueue = (error: any, token: string | null = null) => {
	failedQueue.forEach(prom => {
		if (error) {
			prom.reject(error);
		} else {
			prom.resolve(token);
		}
	});
	
	failedQueue = [];
};

// Add response interceptor for handling auth errors with automatic token refresh
apiClient.interceptors.response.use(
	response => response,
	async error => {
		const originalRequest = error.config;
		
		// Only handle 401 errors for non-auth endpoints
		if (error.response?.status === 401 && !originalRequest._retry) {
			// Skip refresh token endpoint to avoid infinite loop
			if (originalRequest.url?.includes('/auth/refresh')) {
				console.log('Refresh token endpoint failed, logging out');
				auth.logout();
				return Promise.reject(error);
			}

			// Mark this request as retried to avoid infinite loops
			originalRequest._retry = true;

			if (isRefreshing) {
				// If we're already refreshing, queue this request
				console.log('Queueing request while refreshing token:', originalRequest.url);
				return new Promise((resolve, reject) => {
					failedQueue.push({ 
						resolve: (token: string) => {
							if (token) {
								originalRequest.headers['Authorization'] = 'Bearer ' + token;
								resolve(apiClient(originalRequest));
							} else {
								reject(new Error('Token refresh failed'));
							}
						}, 
						reject 
					});
				});
			}

			console.log('Starting token refresh due to 401 error for:', originalRequest.url);
			isRefreshing = true;

			// If there's already a refresh in progress, wait for it
			if (refreshPromise) {
				try {
					const newToken = await refreshPromise;
					originalRequest.headers['Authorization'] = 'Bearer ' + newToken;
					return apiClient(originalRequest);
				} catch (refreshError) {
					return Promise.reject(refreshError);
				}
			}

			// Start new refresh process
			refreshPromise = auth.refreshToken();

			try {
				// Attempt to refresh token
				const newToken = await refreshPromise;
				console.log('Token refreshed successfully');
				
				// Update authorization header for the original request
				if (originalRequest.headers) {
					originalRequest.headers['Authorization'] = 'Bearer ' + newToken;
				}
				
				// Process any queued requests with the new token
				processQueue(null, newToken);
				
				// Retry the original request
				return apiClient(originalRequest);
			} catch (refreshError) {
				console.error('Token refresh failed:', refreshError);
				
				// Refresh failed, reject all queued requests
				processQueue(refreshError, null);
				
				// Logout user
				auth.logout();
				
				// Prevent multiple redirects
				if (!isRedirectingToLogin) {
					isRedirectingToLogin = true;
					setTimeout(() => {
						isRedirectingToLogin = false;
					}, 2000);
				}
				
				return Promise.reject(refreshError);
			} finally {
				isRefreshing = false;
				refreshPromise = null;
			}
		}

		// For non-401 errors or already retried requests, reject normally
		return Promise.reject(error);
	}
);

export const getMockStatus = async (): Promise<ConfigResponse[]> => {
	const response = await apiClient.get('/status');
	return response.data.data;
};

export const getWorkspaces = async (): Promise<Workspace[]> => {
	const response = await apiClient.get('/workspaces');
	return response.data.data;
};

export const createWorkspace = async (name: string): Promise<Workspace> => {
	const response = await apiClient.post('/workspaces', {
		name
	});
	return response.data.data;
};

export const deleteWorkspace = async (workspaceId: string): Promise<any> => {
	const response = await apiClient.delete(`/workspaces/${workspaceId}`);
	return response.data;
}

export const getProjects = async (): Promise<Project[]> => {
	let workspaceId = getCurrentWorkspaceId();
	// If no workspaceId provided, this will fail with the new API structure
	if (!workspaceId) {
		console.error('No workspace ID provided for getProjects');
		return [];
	}
	const response = await apiClient.get(`/workspaces/${workspaceId}/projects`);
	return response.data.data;
};

export const deleteProject = async (projectId: string): Promise<any> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.delete(`/workspaces/${workspaceId}/projects/${projectId}`);
	return response.data;
};
export const deleteEndpoint = async (projectId: string, endpointId: string): Promise<any> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.delete(`/workspaces/${workspaceId}/projects/${projectId}/endpoints/${endpointId}`);
	return response.data;
}
export const deleteResponse = async (projectId: string, endpointId: string, responseId: string): Promise<any> => {
	const workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.delete(`/workspaces/${workspaceId}/projects/${projectId}/endpoints/${endpointId}/responses/${responseId}`);
	return response.data;
}

export const duplicateResponse = async (projectId: string, endpointId: string, responseId: string): Promise<Response> => {
	const workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.post(`/workspaces/${workspaceId}/projects/${projectId}/endpoints/${endpointId}/responses/${responseId}/duplicate`);
	return response.data.data;
};

export const updateProjectStatus = async (projectId: string, status: string): Promise<Project> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.put(`/workspaces/${workspaceId}/projects/${projectId}`, {
		status: status
	});
	return response.data.data;
};

export const addProject = async (name: string, alias: string): Promise<Project> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.post(`/workspaces/${workspaceId}/projects`, {
		name,
		alias
	});
	return response.data.data;
};

export const addEndpoint = async (projectId: string, method: string, path: string): Promise<Endpoint> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.post(`/workspaces/${workspaceId}/projects/${projectId}/endpoints`, {
		method,
		path,
		enabled: true,
		response_mode: 'random',
	});
	return response.data.data;
};

export const addResponse = async (projectId: string, endpointId: string, statusCode: number, body: string, headers: string, documentation: string): Promise<Response> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.post(`/workspaces/${workspaceId}/projects/${projectId}/endpoints/${endpointId}/responses`, {
		statusCode,
		body,
		headers,
		priority: 0,
		delayMs: 0,
		stream: false,
		enabled: true,
		documentation,
	});
	return response.data.data;
};

export const getProjectDetail = async (projectId: string): Promise<Project> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.get(`/workspaces/${workspaceId}/projects/${projectId}`);
	return response.data.data;
}

export const startMockServer = async (port: number, configFile: string, uuid: string): Promise<any> => {
	const response = await apiClient.post('/start', {
		uuid,
		port,
		configFile
	});
	return response.data;
};

export const stopMockServer = async (port: number): Promise<any> => {
	const response = await apiClient.post('/stop', {
		port
	});
	return response.data;
};

export const deleteConfig = async (filename: string): Promise<any> => {
	const response = await apiClient.delete(`/configs/${filename}`);
	return response.data;
};

export const login = async (credentials: AuthCredentials): Promise<boolean> => {
	// Note: This function is now deprecated - use auth.login from auth store instead
	// Adapting old function to use the new auth system
	try {
		await auth.login(credentials.username, credentials.password);
		return true;
	} catch (error) {
		console.error('Login failed:', error);
		return false;
	}
};

export const getConfigDetails = async (uuid: string): Promise<ConfigResponse> => {
	const response = await apiClient.get(`/configs/${uuid}`);
	return response.data.data;
};


export const saveGitConfig = async (config: {
	gitName: string;
	gitEmail: string;
	gitBranch: string;
	sshKey: string;
	gitUrl: string;
}): Promise<{ success: boolean; message: string }> => {
	const response = await apiClient.post('/git/save-config', config);
	return response.data;
};

export const saveAndTestSyncGit = async (config: {
	gitName: string;
	gitEmail: string;
	gitBranch: string;
	sshKey: string;
	gitUrl: string;
}): Promise<{ success: boolean; message: string }> => {
	const response = await apiClient.post('/git/save-and-test-sync', config);
	return response.data;
};

export const getGitConfig = async (): Promise<{
	success: boolean;
	data?: {
		gitName: string;
		gitEmail: string;
		gitUrl: string;
		gitBranch: string;
		sshKey: string;
	};
	message?: string;
}> => {
	const response = await apiClient.get('/git/config');
	return response.data;
};

export const updateEndpoint = async (projectId: string, endpointId: string, data: {
	method?: string;
	path?: string;
	enabled?: boolean;
	responseMode?: string;
	documentation?: string;
	use_proxy?: boolean;
	proxy_target_id?: string | null;
}): Promise<Endpoint> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.put(`/workspaces/${workspaceId}/projects/${projectId}/endpoints/${endpointId}`, data);
	return response.data.data;
};

export const updateResponse = async (projectId: string, endpointId: string, responseId: string, data: {
	statusCode?: number;
	body?: string;
	headers?: string;
	priority?: number;
	delay_ms?: number;
	stream?: boolean;
	enabled?: boolean;
	is_fallback?: boolean;
}): Promise<Response> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.put(`/workspaces/${workspaceId}/projects/${projectId}/endpoints/${endpointId}/responses/${responseId}`, data);
	return response.data.data;
};

// Get logs with pagination
export const getLogs = async (page: number = 1, pageSize: number = 100, projectId: string): Promise<{ logs: RequestLog[], total: number }> => {
	let workspaceId = getCurrentWorkspaceId();
	const params: Record<string, string> = {
		page: page.toString(),
		pageSize: pageSize.toString()
	};

	const response = await apiClient.get(`/workspaces/${workspaceId}/projects/${projectId}/logs`, { params });
	return {
		logs: response.data.logs,
		total: response.data.total
	};
};

// Create an EventSource for real-time log streaming
export const createLogStream = (projectId: string, limit: number = 100): EventSource => {
	let workspaceId = getCurrentWorkspaceId();
	let baseURL = `${import.meta.env.VITE_API_BASE_URL || 'http://localhost:3600/api'}`;
	let url = `${baseURL}/workspaces/${workspaceId}/projects/${projectId}/logs/stream?limit=${limit}`;

	// Add authentication using JWT token
	const token = auth.getToken();
	if (token) {
		url += `&auth=Bearer ${token}`;
	}

	console.log('Creating SSE connection to:', url);

	const eventSource = new EventSource(url);

	// Add global error handling
	eventSource.onerror = (err) => {
		console.error('EventSource global error:', err);
	};

	return eventSource;
};

// Proxy management APIs
export const listProxyTargets = async (projectId: string): Promise<ProxyTarget[]> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.get(`/workspaces/${workspaceId}/projects/${projectId}/proxies`);
	return response.data.data;
};

export const createProxyTarget = async (projectId: string, label: string, url: string): Promise<ProxyTarget> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.post(`/workspaces/${workspaceId}/projects/${projectId}/proxies`, {
		label,
		url
	});
	return response.data.data;
};

export const updateProxyTarget = async (projectId: string, proxyId: string, data: {
	label?: string;
	url?: string;
}): Promise<ProxyTarget> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.put(`/workspaces/${workspaceId}/projects/${projectId}/proxies/${proxyId}`, data);
	return response.data.data;
};

export const deleteProxyTarget = async (projectId: string, proxyId: string): Promise<any> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.delete(`/workspaces/${workspaceId}/projects/${projectId}/proxies/${proxyId}`);
	return response.data;
};

export const getProxyTarget = async (projectId: string, proxyId: string): Promise<ProxyTarget> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.get(`/workspaces/${workspaceId}/projects/${projectId}/proxies/${proxyId}`);
	return response.data.data;
};

// Update project mode function (for switching between 'mock' and 'proxy' modes)
export const updateProjectMode = async (projectId: string, mode: string): Promise<Project> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.put(`/workspaces/${workspaceId}/projects/${projectId}`, {
		mode: mode
	});
	return response.data.data;
};

// Update project details function 
export const updateProject = async (projectId: string, data: {
	name?: string;
	alias?: string;
	mode?: string;
	timeout?: number;
	cors_enabled?: boolean;
	active_proxy_id?: string;
}): Promise<Project> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.put(`/workspaces/${workspaceId}/projects/${projectId}`, data);
	return response.data.data;
};

// Function fetchUserProfile has been moved to lib/utils/authUtils.ts

export const getProxyTargets = async (projectId: string): Promise<ProxyTarget[]> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.get(`/workspaces/${workspaceId}/projects/${projectId}/proxies`);
	return response.data.data;
};

// User Management API Functions

export interface UpdateUserPayload {
	name?: string;
	email?: string;
}

export interface UpdatePasswordPayload {
	current_password: string;
	new_password: string;
}

export interface SystemConfigItem {
	id: string;
	key: string;
	value: string;
	type: string;
	description: string;
	hide_value: boolean;
	created_at: string;
	updated_at: string;
}

/**
 * Update user profile
 * @param userId User ID to update
 * @param data Fields to update (name, email)
 * @returns Updated user data
 */
export const updateUserProfile = async (userId: string, data: UpdateUserPayload): Promise<User> => {
	const response = await apiClient.patch(`/users/profile`, data);

	// Update auth store with the new user data
	if (response.data.success && response.data.data) {
		auth.updateUserData(response.data.data);
	}

	return response.data.data;
};

/**
 * Update user password
 * @param currentPassword Current password for verification
 * @param newPassword New password to set
 * @returns Success message
 */
export const updatePassword = async (currentPassword: string, newPassword: string): Promise<{ success: boolean; message: string }> => {
	const payload: UpdatePasswordPayload = {
		current_password: currentPassword,
		new_password: newPassword
	};

	const response = await apiClient.post('/users/change-password', payload);
	return {
		success: response.data.success,
		message: response.data.message
	};
};

/**
 * Get a system configuration by key
 * @param key Configuration key
 * @returns SystemConfigItem
 */
export const getSystemConfig = async (key: string): Promise<SystemConfigItem> => {
	const response = await apiClient.get(`/system-config/${key}`);
	return response.data.data;
};

/**
 * Get all available system configurations
 * @returns Array of SystemConfigItem
 */
export const getAllSystemConfigs = async (): Promise<SystemConfigItem[]> => {
	const response = await apiClient.get('/system-configs');
	return response.data.data;
};

/**
 * Update a system configuration
 * @param key Configuration key
 * @param value New value
 * @returns Updated configuration
 */
export const updateSystemConfig = async (key: string, value: string): Promise<SystemConfigItem> => {
	const response = await apiClient.put(`/system-config/${key}`, { value });
	return response.data.data;
};

/**
 * Check if a feature flag is enabled
 * @param key Feature flag key (should start with 'feature_')
 * @param defaultValue Default value if flag doesn't exist
 * @returns Boolean value indicating if feature is enabled
 */
export const isFeatureEnabled = async (key: string, defaultValue = false): Promise<boolean> => {
	try {
		// Make sure key has feature_ prefix
		const featureKey = key.startsWith('feature_') ? key : `feature_${key}`;
		const config = await getSystemConfig(featureKey);
		return config.value === 'true';
	} catch (error) {
		console.warn(`Feature flag ${key} not found, using default: ${defaultValue}`);
		return defaultValue;
	}
};

// Bookmark API functions

/**
 * Gets all bookmarks for a project
 * @param projectId The project ID
 * @returns Array of bookmarked logs
 */
export const getBookmarks = async (projectId: string): Promise<RequestLog[]> => {
	const workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.get(`/workspaces/${workspaceId}/projects/${projectId}/logs/bookmark`);

	if (!response.data.success) {
		throw new Error(response.data.message || 'Failed to get bookmarks');
	}

	return response.data.data;
};

/**
 * Adds a log to bookmarks
 * @param projectId The project ID
 * @param log The log to bookmark
 */
export const addBookmark = async (projectId: string, log: RequestLog): Promise<void> => {
	const workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.post(`/workspaces/${workspaceId}/projects/${projectId}/logs/bookmark`, {
		logs: JSON.stringify(log) // Send the full log object as a JSON string
	});

	if (!response.data.success) {
		throw new Error(response.data.message || 'Failed to add bookmark');
	}

	// Update log object locally
	log.bookmark = true;
};

/**
 * Deletes a bookmark
 * @param projectId The project ID
 * @param logId The log ID to unbookmark
 */
export const deleteBookmark = async (projectId: string, logId: string): Promise<void> => {
	const workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.delete(`/workspaces/${workspaceId}/projects/${projectId}/logs/bookmark/${logId}`);

	if (!response.data.success) {
		throw new Error(response.data.message || 'Failed to delete bookmark');
	}
};

/**
 * Reorder responses by updating their priority values
 * @param projectId Project ID
 * @param endpointId Endpoint ID
 * @param responseOrders Array of response IDs in the desired order
 * @returns Updated responses
 */
export const reorderResponses = async (projectId: string, endpointId: string, responseOrders: string[]): Promise<Response[]> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.put(`/workspaces/${workspaceId}/projects/${projectId}/endpoints/${endpointId}/responses/reorder`, {
		order: responseOrders
	});
	return response.data.data;
};

/**
 * Get project advance configuration
 * @param projectId Project ID
 * @returns Project advance configuration
 */
export const getProjectAdvanceConfig = async (projectId: string): Promise<any> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.get(`/workspaces/${workspaceId}/projects/${projectId}/advance-config`);
	return response.data.data;
};

/**
 * Update project advance configuration
 * @param projectId Project ID
 * @param config Advance configuration object (e.g., {delayMs: 5000})
 * @returns Updated configuration
 */
export const updateProjectAdvanceConfig = async (projectId: string, config: any): Promise<any> => {
	let workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.put(`/workspaces/${workspaceId}/projects/${projectId}/advance-config`, config);
	return response.data.data;
};

/**
 * Search for existing projects by name/alias and check alias availability
 * @param query Search query string
 * @returns Alias availability and matching projects
 */
export const checkAliasAndSearchProjects = async (query: string): Promise<AliasAvailabilityResponse> => {
	const response = await apiClient.post('/projects/check-alias', { query });
	return response.data.data;
};

/**
 * Get public configuration (landing page settings, authentication status, etc.)
 * This endpoint is accessible without authentication
 * @returns Public configuration data
 */
export const getPublicConfig = async (): Promise<PublicConfigResponse> => {
	const response = await apiClient.get('/config/public');
	return response.data.data;
};

/**
 * Clears all non-bookmarked logs for a project
 * @param projectId The project ID
 * @returns Number of logs cleared
 */
export const clearProjectLogsApi = async (projectId: string): Promise<number> => {
	const workspaceId = getCurrentWorkspaceId();
	const response = await apiClient.delete(`/workspaces/${workspaceId}/projects/${projectId}/logs/clear`);

	if (!response.data.success) {
		throw new Error(response.data.message || 'Failed to clear logs');
	}

	return response.data.rowsDeleted || 0;
};