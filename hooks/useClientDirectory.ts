import { useCallback, useEffect, useState } from 'react';
import {
  listClientCenterClients,
  type ClientCenterClient,
} from '../utils/clientCenter';

export const CLIENT_DIRECTORY_CHANGED_EVENT = 'bazarvan:client-directory-changed';

export const notifyClientDirectoryChanged = (): void => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CLIENT_DIRECTORY_CHANGED_EVENT));
  }
};

export const useClientDirectory = () => {
  const [clients, setClients] = useState<ClientCenterClient[]>([]);
  const [isLoadingClients, setIsLoadingClients] = useState(true);
  const [clientDirectoryError, setClientDirectoryError] = useState('');

  const refreshClients = useCallback(async () => {
    setIsLoadingClients(true);
    setClientDirectoryError('');
    try {
      setClients(await listClientCenterClients());
    } catch (error) {
      setClients([]);
      setClientDirectoryError(
        error instanceof Error ? error.message : 'تعذر تحميل قائمة العملاء.',
      );
    } finally {
      setIsLoadingClients(false);
    }
  }, []);

  useEffect(() => {
    void refreshClients();
    const handleDirectoryChanged = () => {
      void refreshClients();
    };
    window.addEventListener(CLIENT_DIRECTORY_CHANGED_EVENT, handleDirectoryChanged);
    return () => window.removeEventListener(CLIENT_DIRECTORY_CHANGED_EVENT, handleDirectoryChanged);
  }, [refreshClients]);

  return {
    clients,
    activeClients: clients.filter(client => client.isActive),
    isLoadingClients,
    clientDirectoryError,
    refreshClients,
  };
};
