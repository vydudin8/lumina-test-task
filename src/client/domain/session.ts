import { api } from '#client/lib/api.ts'
import type { Role, User } from '#common/schemas.ts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export const roleLabels: Record<Role, string> = { lead: 'Sales lead', rep: 'Sales rep' }
// Audit rows also carry 'system'; it shows as it is.
export const roleLabel = (role: string) => roleLabels[role as Role] ?? role

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
