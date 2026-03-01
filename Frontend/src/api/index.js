/**
 * API Base Client
 * Centralized axios instance with interceptors for auth and error handling
 */
import axios from 'axios';

// Base URL from environment or default to backend port
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080/api';

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // Send cookies with requests
});

// Request interceptor - add auth token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor - handle errors and token refresh
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // If 401 and we haven't tried refreshing yet
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        // Try to refresh the token
        const refreshToken = localStorage.getItem('refreshToken');
        if (refreshToken) {
          const response = await axios.post(`${API_BASE_URL}/customer/auth/refresh-token`, {
            refreshToken,
          });

          const { token } = response.data;
          if (token) {
            localStorage.setItem('accessToken', token);
          }

          // Retry the original request with new token
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return api(originalRequest);
        }
      } catch (refreshError) {
        // Refresh failed - clear tokens and redirect to login
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem('user');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    // Handle other errors
    const responseData = error.response?.data || {};
    const fieldErrors = Array.isArray(responseData?.errors)
      ? responseData.errors
          .map((item) => item?.message || item?.msg || item?.error)
          .filter(Boolean)
      : [];

    const errorMessage =
      responseData?.message ||
      responseData?.error ||
      (fieldErrors.length > 0 ? fieldErrors.join(', ') : null) ||
      error.message ||
      'An error occurred';
    
    return Promise.reject({
      status: error.response?.status,
      message: errorMessage,
      data: error.response?.data,
    });
  }
);

export default api;

// Helper methods
export const setAuthToken = (token) => {
  if (token) {
    localStorage.setItem('accessToken', token);
  } else {
    localStorage.removeItem('accessToken');
  }
};

export const setRefreshToken = (token) => {
  if (token) {
    localStorage.setItem('refreshToken', token);
  } else {
    localStorage.removeItem('refreshToken');
  }
};

export const clearTokens = () => {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('user');
};

export const getStoredUser = () => {
  const user = localStorage.getItem('user');
  return user ? JSON.parse(user) : null;
};

export const setStoredUser = (user) => {
  if (user) {
    localStorage.setItem('user', JSON.stringify(user));
  } else {
    localStorage.removeItem('user');
  }
};
