import {
  BaseMindooTenantFactory,
  InMemoryContentAddressedStoreFactory,
  KeyBag,
} from "mindoodb";

async function main() {
  const storeFactory = new InMemoryContentAddressedStoreFactory();
  const factory = new BaseMindooTenantFactory(storeFactory);

  const user = await factory.createUserId("CN=node-todo-user/O=demo", "user-password");
  const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, "user-password");

  const adminSigning = await factory.createSigningKeyPair("admin-password");
  const adminEncryption = await factory.createEncryptionKeyPair("admin-password");

  const tenant = await factory.createTenant(
    "node-todo-tenant",
    adminSigning.publicKey,
    adminEncryption.publicKey,
    "tenant-password",
    user,
    "user-password",
    keyBag
  );

  const db = await tenant.openDB("todos");

  const todo = await db.createDocument();
  await db.changeDoc(todo, async (d) => {
    const data = d.getData();
    data.title = "Buy milk";
    data.done = false;
  });

  const todoIds = await db.getAllDocumentIds();
  const loadedTodo = await db.getDocument(todoIds[0]);
  console.log("Loaded todo:", loadedTodo.getData());
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exit(1);
});
