# Mentions de Licences Tierces / Third-Party Notices

Ce document récapitule les licences des dépendances et composants tiers utilisés directement ou embarqués dans le projet `paperclip-adapter-omniroute`.

---

## 1. Dépendances principales Paperclip (Licence MIT)

### @paperclipai/adapter-utils et @paperclipai/shared
- **Copyright** : Copyright (c) Paperclip Authors
- **Licence** : MIT
- **Texte de licence** :
```
MIT License

Copyright (c) Paperclip Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. Dépendances embarquées via adapter-utils (Licence Apache-2.0)

Certaines dépendances embarquées dans l'arbre d'exécution de `@paperclipai/adapter-utils` sont distribuées sous licence Apache License, Version 2.0 :

- `bare-path`
- `bare-os`
- `b4a`
- `events-universal`
- `text-decoder`

### Notice spécifique `bare-path`
```
Bare Path
Copyright (c) 2023 Holepunch

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0
```

---

## 3. Dépendances de développement et compilation

### TypeScript
- **Licence** : Apache-2.0
- **Copyright** : Microsoft Corporation

### expect-type
- **Licence** : Apache-2.0
- **Copyright** : Sam L'ecuyer

### picocolors, siginfo
- **Licence** : ISC

### source-map-js
- **Licence** : BSD-3-Clause

### Vitest, Vite
- **Licence** : MIT
- **Copyright** : Anthony Fu, Vitest contributors
