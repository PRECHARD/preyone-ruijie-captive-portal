export interface DeviceRegisterBody {
  code?: string;
  error?: string;
  max_devices?: number;
}

/** Message shown when auto-register is refused. Null means the call succeeded. */
export function deviceRegistrationMessage(status: number, body: DeviceRegisterBody): string | null {
  if (status < 400) return null;
  if (body.code === 'DEVICE_LIMIT_EXCEEDED') {
    return (
      body.error ||
      'This computer is over your plan’s device limit. Upgrade the plan or remove a device in the admin console.'
    );
  }
  return body.error || 'This computer could not be registered.';
}
