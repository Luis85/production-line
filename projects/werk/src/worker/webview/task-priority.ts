export const taskPriorityOptions = ['Low', 'Normal', 'High', 'Urgent'].map((label, value) => ({ label, value }));
export const taskPriorityLabel = (value: number) => taskPriorityOptions.find(option => option.value === value)?.label ?? 'Unknown priority';
