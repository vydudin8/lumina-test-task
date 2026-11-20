import type { Role, User } from '#common/schemas.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './api.ts'

export const roleLabels: Record<Role, string> = { lead: 'Sales lead', rep: 'Sales rep' }

export function useSession() {
	return useQuery({
		queryKey: ['session'],
		queryFn: () => api<{ user: User | null }>('/api/session'),
		select: (data) => data.user,
	})
}

export function useUsers() {
	return useQuery({
		queryKey: ['users'],
		queryFn: () => api<{ users: User[] }>('/api/users'),
		select: (data) => data.users,
	})
}

export function usePickUser() {
	const queryClient = useQueryClient()
	return useMutation({
		mutationFn: (userId: string) => api<{ user: User }>('/api/session', { method: 'PUT', json: { userId } }),
		// What a user may see and do depends on the role, so everything is refetched.
		onSuccess: () => queryClient.invalidateQueries(),
	})
}

// "usr_rep_tom" -> "Tom Okafor"; system actors and unknown ids are shown as they are.
export function useUserName() {
	const { data: users = [] } = useUsers()
	return (id: string) => users.find((user) => user.id === id)?.name ?? id
}
