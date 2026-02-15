import React, { useState } from "react";
import { SafeAreaView, Text, TouchableOpacity, View } from "react-native";
import {
  BaseMindooTenantFactory,
  InMemoryContentAddressedStoreFactory,
  KeyBag,
  QuickCryptoAdapter,
} from "mindoodb";
import * as quickCrypto from "react-native-quick-crypto";

export default function App() {
  const [status, setStatus] = useState("Idle");
  const [todo, setTodo] = useState<null | { title?: string; done?: boolean }>(null);

  const runDemo = async () => {
    setStatus("Running...");
    try {
      const storeFactory = new InMemoryContentAddressedStoreFactory();
      const cryptoAdapter = new QuickCryptoAdapter(quickCrypto);
      const factory = new BaseMindooTenantFactory(storeFactory, cryptoAdapter);

      const user = await factory.createUserId("CN=rn-todo-user/O=demo", "user-password");
      const adminUser = await factory.createUserId("CN=admin/O=demo", "admin-password");
      const keyBag = new KeyBag(
        user.userEncryptionKeyPair.privateKey,
        "user-password",
        cryptoAdapter
      );

      const tenant = await factory.openTenant(
        "rn-todo-tenant",
        adminUser.userSigningKeyPair.publicKey,
        adminUser.userEncryptionKeyPair.publicKey,
        user,
        "user-password",
        keyBag
      );

      const db = await tenant.openDB("todos");
      const doc = await db.createDocument();
      await db.changeDoc(doc, async (d) => {
        const data = d.getData();
        data.title = "Pay invoices";
        data.done = false;
      });

      const ids = await db.getAllDocumentIds();
      const loaded = await db.getDocument(ids[0]);
      setTodo(loaded.getData() as { title?: string; done?: boolean });
      setStatus("Done");
    } catch (error) {
      setStatus(`Error: ${(error as Error).message}`);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, padding: 24, backgroundColor: "#fff" }}>
      <Text style={{ fontSize: 20, fontWeight: "600", marginBottom: 16 }}>
        MindooDB React Native Todo Demo
      </Text>
      <TouchableOpacity
        onPress={runDemo}
        style={{ backgroundColor: "#1f6feb", padding: 12, borderRadius: 8, marginBottom: 16 }}
      >
        <Text style={{ color: "#fff", textAlign: "center", fontWeight: "600" }}>Run Demo</Text>
      </TouchableOpacity>
      <View>
        <Text style={{ marginBottom: 8 }}>Status: {status}</Text>
        {todo ? (
          <Text>
            Todo: {todo.title} (done: {String(todo.done)})
          </Text>
        ) : (
          <Text>No todo created yet.</Text>
        )}
      </View>
    </SafeAreaView>
  );
}
